# Problems faced

A running log of real problems hit while building this, each with the actual
root cause and the fix — not a polished changelog. Kept because "I do not put
anything on my CV I cannot defend in an interview" only works if the
reasoning behind each fix is still here six months later, not just the diff.

---

## LoRA adapter free-associates from unrelated prior turns

**Symptom.** Deployed `gpt2-medium` + the Dolly LoRA adapter, multi-turn:

```
User: what is the capital of france       -> Paris
User: what is the capital of India        -> Delhi
User: why is sky blue                     -> "because sky blue is a colour
                                              of Indian national flag"
```

The third answer has nothing to do with the third question. It pulled
"India" out of the *second* turn.

**Confirming it was real, not one bad sample.** Reran the same 4-turn history
against the deployed defaults (temperature 0.8, top_k 50) across 6 seeds:

```
WITH the France/India history:
  seed 2: drifts into inventing a new "User:" turn mid-answer
  seed 4: "India has both a capital, Delhi, and an official name"

SAME question ("why is sky blue"), NO history, 6 seeds:
  none mention India, France, or capitals at all
```

Roughly 1-in-6 at these settings, and it never happens without the
unrelated history present. Not a fluke.

**Root cause.** The training data is 100% single-turn.
`prompt_format.render_training_example` hardcodes empty history:

```python
def render_training_example(instruction, response):
    return render_prompt([], instruction), render_response(response)
```

Every one of the 10,400 Dolly examples the adapter trained on was
`User: {q}\nAssistant:{a}` in isolation — the adapter has never once seen a
finished, unrelated exchange sitting in context before the question it's
supposed to answer.

But `GPTKVEngine._render_prompt` renders the *entire* conversation history
into the same flat string at serving time. So live, the model sees a
completed India Q&A directly above a completely unrelated question, and
nothing in training ever taught it "ignore the turn above, it's over." A
355M model with no multi-turn exposure defaults to associating nearby
salient tokens (`India`, `Delhi`) with whatever comes next, rather than
correctly treating the prior turn as closed.

This is the same *class* of bug Phase 0 solved for token-level prompt
format (train and serve must render identically) — except here the mismatch
is one level up, in conversation *structure*, not tokens. Phase 0 checked
that `encode(prompt) + encode(response) == encode(prompt + response)`; it
never checked that history-bearing prompts looked anything like what
training saw, because training never had any.

**Fix (not yet built).** Synthesize multi-turn training examples: chain 1-2
unrelated Q&A pairs as history in front of a genuinely unrelated final
question, mask loss so only the final response is supervised — same masking
scheme already in `training/finetune_lora.py`, just with non-empty history
passed into `render_prompt`. That teaches the adapter to discard irrelevant
prior turns instead of free-associating from them.

**Cheaper interim mitigation, not a real fix.** Cap how many prior turns get
rendered into context (e.g. last 1 exchange only). Reduces exposure, doesn't
close the gap — a 2-turn conversation still triggers it.

**Where the numbers came from.** Reproduced directly through the real
serving path, not a standalone script — `GPTKVEngine` loaded with the actual
deployed adapter, `GenerationParams` built with the same defaults
`PredictRequests` uses (`temperature=0.8`, `top_k=50`), history built the
same shape the route handler passes (`[{"role", "content"}, ...]`).
