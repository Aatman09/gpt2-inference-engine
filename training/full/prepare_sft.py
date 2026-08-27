"""Turn databricks-dolly-15k into masked, fixed-length SFT arrays.

Produces, per split, two (N, T) int32 arrays:

  x       -- input token ids, right-padded
  labels  -- x shifted left by one, with -100 everywhere loss must not apply

-100 is F.cross_entropy's default ignore_index, so model_kv.GPT needs NO
changes to train on this -- which matters more than usual because model_kv.py
is also the serving path.

Masking the prompt is not optional. Train on every position and you teach the
model to generate the user's questions as readily as the answers.

    python training/full/prepare_sft.py --out data/dolly_sft
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

import numpy as np
import tiktoken
from tqdm import tqdm

from prompt_format import EOT_TOKEN, FORMAT_VERSION, render_training_example

DATASET = "databricks/databricks-dolly-15k"
IGNORE_INDEX = -100


def build_example(enc, instruction: str, response: str, max_len: int):
    """One (x, labels) pair, or None if it does not fit.

    Prompt and response are tokenized separately so the mask boundary is
    exact. That is only sound because the two encodings concatenate to the
    same ids as encoding the joined string -- BPE does not merge across
    "Assistant:" and the reply's leading space. prompt_format.py explains why
    the space sits where it does; verify_data.py asserts it still holds.
    """
    prompt, completion = render_training_example(instruction, response)
    prompt_ids = enc.encode(prompt)
    response_ids = enc.encode(completion, allowed_special={"<|endoftext|>"})
    full = prompt_ids + response_ids

    # x is full[:-1] and labels is full[1:], so a full of T+1 fills exactly
    # one T-long window. Drop rather than truncate: a truncated example loses
    # its <|endoftext|>, which trains the model NOT to stop -- the precise
    # failure this whole exercise exists to fix.
    if len(full) > max_len + 1:
        return None

    x = np.full(max_len, EOT_TOKEN, dtype=np.int32)
    labels = np.full(max_len, IGNORE_INDEX, dtype=np.int32)

    body = full[:-1]
    x[: len(body)] = body

    # labels[i] is the token to predict at position i, i.e. full[i+1]. That is
    # a response token when i + 1 >= len(prompt_ids), so the first supervised
    # position is len(prompt_ids) - 1 -- the position holding the final ":" of
    # "Assistant:", which is what predicts the reply's first token. Off by one
    # here and you supervise the wrong half of every example.
    start = len(prompt_ids) - 1
    labels[start : len(full) - 1] = full[start + 1 :]

    assert (labels != IGNORE_INDEX).sum() == len(response_ids), "mask/response length mismatch"
    return x, labels


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data/dolly_sft")
    ap.add_argument("--max-len", type=int, default=512)
    ap.add_argument("--val-size", type=int, default=500)
    ap.add_argument("--seed", type=int, default=1337)
    ap.add_argument(
        "--include-context",
        action="store_true",
        help="keep Dolly's closed_qa/summarisation examples, folding the context "
             "into the user turn. Off by default: they are long, they dominate the "
             "token budget, and reading comprehension over a passage is beyond 124M.",
    )
    ap.add_argument("--limit", type=int, default=0, help="first N examples only, for smoke tests")
    args = ap.parse_args()

    from datasets import load_dataset

    enc = tiktoken.get_encoding("gpt2")
    rows = load_dataset(DATASET, split="train")
    if args.limit:
        rows = rows.select(range(min(args.limit, len(rows))))

    xs, ys = [], []
    skipped_context = skipped_long = skipped_empty = 0

    for row in tqdm(rows, desc="rendering"):
        instruction, response, context = row["instruction"], row["response"], row["context"]
        if context:
            if not args.include_context:
                skipped_context += 1
                continue
            instruction = f"{instruction}\n\n{context}"
        if not instruction.strip() or not response.strip():
            skipped_empty += 1
            continue
        built = build_example(enc, instruction, response, args.max_len)
        if built is None:
            skipped_long += 1
            continue
        xs.append(built[0])
        ys.append(built[1])

    x = np.stack(xs)
    labels = np.stack(ys)

    # hold out BEFORE shuffling, so a rerun with a different seed cannot leak
    # a previously-validated example into training
    n_val = min(args.val_size, len(x) // 10)
    val_x, val_labels = x[:n_val], labels[:n_val]
    train_x, train_labels = x[n_val:], labels[n_val:]

    rng = np.random.default_rng(args.seed)
    perm = rng.permutation(len(train_x))
    train_x, train_labels = train_x[perm], train_labels[perm]

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    np.save(out / "train_x.npy", train_x)
    np.save(out / "train_labels.npy", train_labels)
    np.save(out / "val_x.npy", val_x)
    np.save(out / "val_labels.npy", val_labels)

    supervised = int((train_labels != IGNORE_INDEX).sum())
    meta = {
        "dataset": DATASET,
        "prompt_format": FORMAT_VERSION,
        "max_len": args.max_len,
        "include_context": args.include_context,
        "train": len(train_x),
        "val": len(val_x),
        "supervised_tokens": supervised,
        "supervised_fraction": round(supervised / train_labels.size, 4),
        "skipped": {"context": skipped_context, "too_long": skipped_long, "empty": skipped_empty},
    }
    (out / "meta.json").write_text(json.dumps(meta, indent=2) + "\n")
    print(json.dumps(meta, indent=2))

    # Decode one example and print exactly which tokens carry loss. The doc
    # calls for eyeballing this BEFORE any training run -- a mask that is off
    # by one still trains, still drops loss, and still produces nothing usable.
    print("\n--- example 0, [] marks supervised positions ---")
    row_x, row_y = train_x[0], train_labels[0]
    pieces = []
    for i in range(args.max_len):
        if row_x[i] == EOT_TOKEN and row_y[i] == IGNORE_INDEX and i > 0:
            break
        tok = enc.decode([int(row_x[i])])
        pieces.append(f"[{tok}]" if row_y[i] != IGNORE_INDEX else tok)
    print("".join(pieces))
    print(f"\nfirst supervised label decodes to: "
          f"{enc.decode([int(row_y[row_y != IGNORE_INDEX][0])])!r}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
