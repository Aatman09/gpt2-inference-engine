"""LoRA instruction-tuning for model_kv.GPT.

Forked from train.py, with the differences SFT actually requires:

                    pretrain (train.py)        LoRA SFT (here)
  learning rate     3e-4 flat                  2e-4, cosine + warmup
  parameters        all ~163M                  442k adapter only
  loss              every token                response tokens only
  data              contiguous token stream    discrete, shuffled examples
  eval              none                       val loss per epoch
  output            650MB .pth                 ~1.8MB adapter

Note the LR does NOT drop the way full finetuning's would. Full SFT needs
1e-5..3e-5 to avoid wrecking pretrained weights; LoRA's base is frozen and B
starts at zero, so it wants roughly 10x that. Starting at 2e-5 is the standard
way to produce an adapter that appears to do nothing.

    python training/full/prepare_sft.py --out data/dolly_sft
    python training/full/train_lora.py  --data data/dolly_sft --out adapters/instruct

Sanity run first -- deliberately overfit a handful of examples. If the adapter
cannot reproduce 64 responses verbatim, the mask, the format or the wiring is
wrong, and you learn that in two minutes instead of after a full run:

    python training/full/train_lora.py --data data/dolly_sft --overfit 64 --epochs 30
"""
import argparse
import json
import math
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

import numpy as np
import torch
from torch.utils.data import DataLoader, Dataset

from model_kv import GPT
from prompt_format import FORMAT_VERSION
from lora import (
    AdapterMeta,
    build_lora_config,
    inject_lora,
    lora_parameters,
    save_adapter,
    trainable_summary,
)


class SFTDataset(Dataset):
    """Discrete, padded examples -- not dataloader2.py's sliding window.

    ShardedDataset walks one contiguous token stream, which is right for
    pretraining on 200M tokens and wrong here: SFT examples are separate, must
    not bleed across boundaries, and 15k of them for 3 epochs genuinely need
    shuffling (the DataLoader does that).
    """

    def __init__(self, directory: Path, split: str):
        self.x = np.load(directory / f"{split}_x.npy")
        self.labels = np.load(directory / f"{split}_labels.npy")
        assert self.x.shape == self.labels.shape

    def __len__(self) -> int:
        return len(self.x)

    def __getitem__(self, i):
        # int64 because nn.Embedding indexes with long, and cross_entropy
        # wants long targets; stored as int32 to halve the file size
        return (
            torch.from_numpy(self.x[i].astype(np.int64)),
            torch.from_numpy(self.labels[i].astype(np.int64)),
        )


def lr_at(step: int, total: int, peak: float, warmup: int, floor_ratio: float = 0.1) -> float:
    """Linear warmup then cosine decay to floor_ratio * peak.

    Warmup matters more than usual: B is zero at step 0, so the adapter's
    gradients start large and unopposed, and a cold high LR can knock it
    somewhere it never recovers from.
    """
    if step < warmup:
        return peak * (step + 1) / warmup
    progress = (step - warmup) / max(1, total - warmup)
    return peak * (floor_ratio + (1 - floor_ratio) * 0.5 * (1 + math.cos(math.pi * progress)))


@torch.no_grad()
def evaluate(model, loader, device, autocast_kw) -> float:
    """Mean loss over supervised positions only.

    Weighted by each batch's token count rather than averaged over batches:
    examples have wildly different response lengths, so an unweighted mean
    would let a batch of one-word answers count as much as a batch of
    paragraphs.
    """
    model.eval()
    total_loss, total_tokens = 0.0, 0
    for x, labels in loader:
        x, labels = x.to(device), labels.to(device)
        n = int((labels != -100).sum())
        if n == 0:
            continue
        with torch.autocast(**autocast_kw):
            _, _, loss = model(x, targets=labels)
        total_loss += loss.item() * n
        total_tokens += n
    model.train()
    return total_loss / max(1, total_tokens)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data/dolly_sft")
    ap.add_argument("--out", default="adapters/instruct")
    ap.add_argument("--adapter-name", default="instruct")
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--batch-size", type=int, default=8)
    ap.add_argument("--grad-accum", type=int, default=8)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--weight-decay", type=float, default=0.0)
    ap.add_argument("--rank", type=int, default=8)
    ap.add_argument("--alpha", type=int, default=16)
    ap.add_argument("--dropout", type=float, default=0.05)
    ap.add_argument("--seed", type=int, default=1337)
    ap.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    ap.add_argument("--overfit", type=int, default=0,
                    help="train on the first N examples and validate on the same ones. "
                         "The pre-flight check: loss must go to near zero.")
    args = ap.parse_args()

    torch.manual_seed(args.seed)
    device = args.device
    data_dir = Path(args.data)

    # bf16 on Ada is native and roughly halves step time. CPU bf16 autocast is
    # the opposite -- it falls back to kernels that barely thread, and a smoke
    # run measured it at roughly 40x slower than plain fp32 -- so it is
    # disabled off CUDA rather than silently making the CPU path unusable.
    autocast_kw = {
        "device_type": device.split(":")[0],
        "dtype": torch.bfloat16,
        "enabled": device.startswith("cuda"),
    }
    if device.startswith("cuda"):
        torch.set_float32_matmul_precision("high")

    train_set = SFTDataset(data_dir, "train")
    val_set = SFTDataset(data_dir, "val")
    if args.overfit:
        train_set.x = train_set.x[: args.overfit]
        train_set.labels = train_set.labels[: args.overfit]
        val_set = train_set

    train_loader = DataLoader(
        train_set, batch_size=args.batch_size, shuffle=True, drop_last=False,
        pin_memory=device.startswith("cuda"),
    )
    val_loader = DataLoader(val_set, batch_size=args.batch_size, shuffle=False)

    # Base weights FIRST, then inject: wrapping moves each targeted Linear to
    # `.base_layer`, so loading a state dict afterwards would key-mismatch.
    model = GPT.from_pretrained("gpt2")
    model.to(device)
    config = build_lora_config(r=args.rank, alpha=args.alpha, dropout=args.dropout)
    wrapped = inject_lora(model, config, adapter_name=args.adapter_name)
    model.train()

    trainable, total = trainable_summary(model)
    print(f"wrapped {len(wrapped)} layers | trainable {trainable:,} of {total:,} "
          f"({100 * trainable / total:.2f}%) | device {device}")
    print(f"train {len(train_set)} | val {len(val_set)} | "
          f"effective batch {args.batch_size * args.grad_accum}")

    params = lora_parameters(model)
    assert sum(p.numel() for p in params) == trainable, "optimizer would miss adapter params"
    optimizer = torch.optim.AdamW(
        params, lr=args.lr, betas=(0.9, 0.95), weight_decay=args.weight_decay,
        fused=device.startswith("cuda"),
    )

    steps_per_epoch = math.ceil(len(train_loader) / args.grad_accum)
    total_steps = steps_per_epoch * args.epochs
    warmup = max(1, min(100, int(0.03 * total_steps)))

    out_dir = Path(args.out)
    history = []
    step = 0
    optimizer.zero_grad(set_to_none=True)

    for epoch in range(args.epochs):
        t0 = time.time()
        running, micro = 0.0, 0
        for i, (x, labels) in enumerate(train_loader):
            x = x.to(device, non_blocking=True)
            labels = labels.to(device, non_blocking=True)

            with torch.autocast(**autocast_kw):
                _, _, loss = model(x, targets=labels)

            # scale so the accumulated gradient equals one large-batch
            # gradient; `running` re-multiplies to report the real loss
            running += loss.item()
            micro += 1
            (loss / args.grad_accum).backward()

            is_last = i == len(train_loader) - 1
            if micro < args.grad_accum and not is_last:
                continue

            for group in optimizer.param_groups:
                group["lr"] = lr_at(step, total_steps, args.lr, warmup)
            norm = torch.nn.utils.clip_grad_norm_(params, 1.0)
            optimizer.step()
            optimizer.zero_grad(set_to_none=True)

            # train.py logged per-microbatch loss, which is noisier by exactly
            # the factor it accumulates over; this is the per-step average
            step_loss = running / micro
            history.append({"step": step, "epoch": epoch, "loss": step_loss})
            if step % 10 == 0:
                print(f"epoch {epoch} | step {step}/{total_steps} | loss {step_loss:.4f} "
                      f"| lr {optimizer.param_groups[0]['lr']:.2e} | norm {norm:.3f}")
            running, micro = 0.0, 0
            step += 1

        val_loss = evaluate(model, val_loader, device, autocast_kw)
        print(f"epoch {epoch} done in {time.time() - t0:.1f}s | val loss {val_loss:.4f}")

        # every epoch, not just at the end: val loss and generation quality
        # diverge, and you want the checkpoint from before that happened
        meta = AdapterMeta(
            base_model="gpt2",
            prompt_format=FORMAT_VERSION,
            dataset=json.loads((data_dir / "meta.json").read_text())["dataset"],
            notes=f"epoch {epoch}, val loss {val_loss:.4f}, lr {args.lr}, r{args.rank}",
        )
        save_adapter(model, out_dir / f"epoch{epoch}", config, meta, adapter_name=args.adapter_name)
        save_adapter(model, out_dir, config, meta, adapter_name=args.adapter_name)
        (out_dir / "history.json").write_text(json.dumps(history, indent=2) + "\n")

    print(f"\nadapter written to {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
