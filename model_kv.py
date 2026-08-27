"""GPT-2 with KV-cache inference.

Mirror of model.py with KV-cache plumbing through the attention layers.
Field names (n_embd, ln_1, ln_2) match model.py so shakespeare_gpt.pth loads.

The cache is a list of (k, v) tensors, one per transformer block.
On the first call, pass kv_caches=None (prefill). On each subsequent call,
pass a single new token along with the returned kv_caches (decode).
"""
import torch
import torch.nn as nn
import torch.nn.functional as F
from dataclasses import dataclass


@dataclass
class GPTConfig:
    block_size: int = 1024
    vocab_size: int = 50304        # padded to a multiple of 64 for matmul alignment
    real_vocab_size: int = 50257   # actual GPT-2 tokens; rows beyond this are untrained
    n_layer: int = 12
    n_embd: int = 768
    n_head: int = 12


class CausalSelfAttention(nn.Module):
    def __init__(self, config: GPTConfig):
        super().__init__()
        assert config.n_embd % config.n_head == 0

        self.c_attn = nn.Linear(config.n_embd, 3 * config.n_embd)
        self.c_proj = nn.Linear(config.n_embd, config.n_embd)

        self.n_head = config.n_head
        self.n_embd = config.n_embd
        self.head_size = config.n_embd // config.n_head

        self.register_buffer(
            "bias",
            torch.tril(torch.ones(config.block_size, config.block_size).view(1, 1, config.block_size, config.block_size))
        )

    def forward(self, x, kv_cache=None):
        B, T, C = x.shape
        qkv = self.c_attn(x)
        q, k, v = qkv.split(self.n_embd, dim=2)

        q = q.view(B, T, self.n_head, self.head_size).transpose(1, 2)
        k = k.view(B, T, self.n_head, self.head_size).transpose(1, 2)
        v = v.view(B, T, self.n_head, self.head_size).transpose(1, 2)

        if kv_cache is not None:
            past_k, past_v = kv_cache
            k = torch.cat([past_k, k], dim=2)
            v = torch.cat([past_v, v], dim=2)

        new_cache = (k, v)

        is_causal = (q.shape[2] == k.shape[2])
        out = F.scaled_dot_product_attention(q, k, v, is_causal=is_causal)

        out = out.transpose(1, 2).contiguous().view(B, T, C)
        out = self.c_proj(out)
        return out, new_cache


class MLP(nn.Module):
    def __init__(self, config: GPTConfig):
        super().__init__()
        self.c_fc = nn.Linear(config.n_embd, 4 * config.n_embd)
        self.gelu = nn.GELU(approximate='tanh')
        self.c_proj = nn.Linear(4 * config.n_embd, config.n_embd)

    def forward(self, x):
        x = self.c_fc(x)
        x = self.gelu(x)
        x = self.c_proj(x)
        return x


class Block(nn.Module):
    def __init__(self, config: GPTConfig):
        super().__init__()
        self.ln_1 = nn.LayerNorm(config.n_embd)
        self.ln_2 = nn.LayerNorm(config.n_embd)
        self.attn = CausalSelfAttention(config)
        self.mlp = MLP(config)

    def forward(self, x, kv_cache=None):
        attn_out, new_cache = self.attn(self.ln_1(x), kv_cache)
        x = x + attn_out
        x = x + self.mlp(self.ln_2(x))
        return x, new_cache


class GPT(nn.Module):
    def __init__(self, config: GPTConfig):
        super().__init__()
        self.config = config

        self.transformer = nn.ModuleDict(dict(
            wte=nn.Embedding(config.vocab_size, config.n_embd),
            wpe=nn.Embedding(config.block_size, config.n_embd),
            h=nn.ModuleList([Block(config) for _ in range(config.n_layer)]),
            ln_f=nn.LayerNorm(config.n_embd),
        ))

        self.lm_head = nn.Linear(config.n_embd, config.vocab_size, bias=False)

    def forward(self, idx, kv_caches=None, targets=None):
        B, T = idx.size()

        past_length = 0
        if kv_caches is not None and kv_caches[0] is not None:
            past_length = kv_caches[0][0].shape[2]

        # check the TOTAL position, not just this call's length -- on the
        # cached decode path T is always 1, so a T-only assert never fires and
        # wpe(pos) silently indexes past its block_size rows (a CUDA
        # device-side assert, or garbage on CPU)
        assert past_length + T <= self.config.block_size, (
            f"Sequence position {past_length + T} exceeds block_size {self.config.block_size}"
        )

        pos = torch.arange(past_length, past_length + T, dtype=torch.long, device=idx.device)
        pos_embd = self.transformer.wpe(pos)
        tok_embd = self.transformer.wte(idx)
        x = tok_embd + pos_embd

        if kv_caches is None:
            kv_caches = [None] * len(self.transformer.h)

        new_kv_caches = []
        for block, kv_cache in zip(self.transformer.h, kv_caches):
            x, new_cache = block(x, kv_cache)
            new_kv_caches.append(new_cache)

        x = self.transformer.ln_f(x)
        logits = self.lm_head(x)

        loss = None
        if targets is not None:
            # Only the real vocabulary is a valid prediction. vocab_size is
            # padded past real_vocab_size for matmul alignment, and those extra
            # lm_head rows are never copied from the checkpoint -- they stay at
            # random init and, untrained, out-argmax the real tokens at ~92% of
            # positions. Including them puts the loss at ~77 where it should be
            # ~2.5. generate() and the serving engine already mask them in
            # logit space for exactly this reason; the loss has to agree.
            #
            # Pretraining got away with it because lm_head was trainable and
            # those rows were quickly driven down. Under LoRA the base is
            # frozen, so they never can be, and the loss would be dominated by
            # noise the adapter has no way to fix.
            logits_real = logits[..., : self.config.real_vocab_size]
            loss = F.cross_entropy(
                logits_real.reshape(-1, self.config.real_vocab_size), targets.reshape(-1)
            )

        return logits, new_kv_caches, loss

    @classmethod
    def from_pretrained(cls, model_type):
        assert model_type in {"gpt2", "gpt2-medium", "gpt2-large", "gpt2-xl"}
        from transformers import GPT2LMHeadModel

        config_args = {
            "gpt2":        dict(n_embd=768,  n_head=12, n_layer=12),
            "gpt2-medium": dict(n_embd=1024, n_head=16, n_layer=24),
            "gpt2-large":  dict(n_embd=1280, n_head=20, n_layer=36),
            "gpt2-xl":     dict(n_embd=1600, n_head=25, n_layer=48),
        }[model_type]

        config_args["vocab_size"] = 50304
        config_args["real_vocab_size"] = 50257
        config_args["block_size"] = 1024

        config = GPTConfig(**config_args)
        model = GPT(config)

        sd = model.state_dict()
        sd_keys = [k for k in sd.keys() if not k.endswith('.attn.bias')]

        model_hf = GPT2LMHeadModel.from_pretrained(model_type)
        sd_hf = model_hf.state_dict()

        sd_keys_hf = [k for k in sd_hf.keys() if not k.endswith('.attn.masked_bias')]
        sd_keys_hf = [k for k in sd_keys_hf if not k.endswith('.attn.bias')]

        transposed = ['attn.c_attn.weight', 'attn.c_proj.weight', 'mlp.c_fc.weight', 'mlp.c_proj.weight']
        assert len(sd_keys_hf) == len(sd_keys)

        padded_vocab = ['transformer.wte.weight', 'lm_head.weight']

        for k in sd_keys_hf:
            if any(k.endswith(w) for w in transposed):
                assert sd_hf[k].t().shape == sd[k].shape
                with torch.no_grad():
                    sd[k].copy_(sd_hf[k].t())
            elif k in padded_vocab:
                # hf checkpoint has 50257 rows; our vocab_size is padded to 50304 for
                # tensor-core alignment, so copy only the real rows and leave the rest
                # as their random init (dead neurons, never fired at inference)
                assert sd_hf[k].shape[0] <= sd[k].shape[0]
                assert sd_hf[k].shape[1:] == sd[k].shape[1:]
                with torch.no_grad():
                    sd[k][:sd_hf[k].shape[0]].copy_(sd_hf[k])
            else:
                assert sd_hf[k].shape == sd[k].shape
                with torch.no_grad():
                    sd[k].copy_(sd_hf[k])

        return model

    @torch.no_grad()
    def generate(self, idx, max_new_tokens, temperature=1.0, top_k=None):
        logits, kv_caches, _ = self(idx)
        for _ in range(max_new_tokens):
            logits = logits[:, -1, :] / temperature
            # vocab_size is padded past the real token count for matmul alignment, so the
            # extra columns are untrained weights that tiktoken cannot decode. Mask them in
            # logit space (before top_k, so all k slots go to real candidates, and before
            # softmax, so the surviving probabilities still normalise to 1).
            logits[:, self.config.real_vocab_size:] = -float('inf')
            if top_k is not None:
                v, _ = torch.topk(logits, min(top_k, logits.size(-1)))
                logits[logits < v[:, [-1]]] = -float('Inf')
            probs = F.softmax(logits, dim=-1)
            next_token = torch.multinomial(probs, num_samples=1)
            idx = torch.cat([idx, next_token], dim=1)
            logits, kv_caches, _ = self(next_token, kv_caches)
        return idx
