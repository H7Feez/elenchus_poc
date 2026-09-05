"""
Fine-tunes a small chat model on the Socratic Debugging Benchmark.

    python model/train.py                 # everything, 1 epoch
    python model/train.py --limit 400     # a quicker run on a subset
    python model/train.py --epochs 2

What it does, in order:
  1. Loads a small pretrained model (Qwen2.5-Coder-0.5B-Instruct: already reads
     English and Python; we only nudge it toward Socratic tutoring).
  2. Freezes all of its 500M weights and adds a few million trainable ones
     alongside them (LoRA — see the comment where it is configured).
  3. Shows it the examples from prepare_data.py. For each one it is graded ONLY
     on the tutor's reply: the student's words are context, never a target.
  4. Saves the small trainable part to model/out/adapter. The base model is
     never modified, so the "before" is always one flag away for comparison.

Runs on the GPU if PyTorch can use it, otherwise on the CPU with a smaller
default subset so it still finishes in reasonable time.
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
OUT = HERE / "out"

BASE_MODEL = "Qwen/Qwen2.5-Coder-0.5B-Instruct"
MAX_LEN = 1024  # tokens per example; the few longer ones are skipped


def pick_device():
    """GPU if PyTorch can actually run a kernel on it; otherwise CPU."""
    import torch
    if torch.cuda.is_available():
        try:
            x = torch.ones(64, 64, device="cuda")
            (x @ x).sum().item()
            name = torch.cuda.get_device_name(0)
            mem = torch.cuda.get_device_properties(0).total_memory / 2**30
            print(f"device: cuda ({name}, {mem:.1f} GB)")
            return "cuda"
        except Exception as e:  # e.g. the wheel has no kernels for this old card
            print(f"CUDA is present but unusable ({type(e).__name__}); falling back to CPU")
    print(f"device: cpu ({os.cpu_count()} threads)")
    return "cpu"


def load_examples(path, limit=None):
    rows = [json.loads(l) for l in open(path, encoding="utf-8")]
    if limit:
        # Spread the subset across the whole file so every dialogue is represented.
        step = max(1, len(rows) // limit)
        rows = rows[::step][:limit]
    return rows


def chat_ids(tokenizer, messages, add_generation_prompt=False):
    """
    Token ids for a chat, as a plain list. transformers 4.x returns a list here
    and 5.x returns a dict-like object, so accept both.
    """
    out = tokenizer.apply_chat_template(
        messages, add_generation_prompt=add_generation_prompt, tokenize=True
    )
    if hasattr(out, "keys") or isinstance(out, dict):
        out = out["input_ids"]
    if len(out) and isinstance(out[0], (list, tuple)):
        out = out[0]
    return [int(t) for t in out]


def load_model(name):
    """from_pretrained's dtype argument was renamed in transformers 5."""
    import torch
    from transformers import AutoModelForCausalLM
    try:
        return AutoModelForCausalLM.from_pretrained(name, dtype=torch.float32)
    except TypeError:
        return AutoModelForCausalLM.from_pretrained(name, torch_dtype=torch.float32)


def tokenize(tokenizer, example):
    """
    Turns one chat example into token ids plus a label for each token.

    A label of -100 means "do not grade this token". Everything up to and
    including the tutor's turn header gets -100; only the tutor's actual words
    are graded. That is how "train on the reply, not the student" is expressed.
    """
    messages = example["messages"]
    prompt_ids = chat_ids(tokenizer, messages[:-1], add_generation_prompt=True)
    full_ids = chat_ids(tokenizer, messages)
    if full_ids[: len(prompt_ids)] != prompt_ids:
        return None  # template did not nest as expected; skip rather than mis-label
    if len(full_ids) > MAX_LEN:
        return None
    labels = [-100] * len(prompt_ids) + full_ids[len(prompt_ids):]
    return {"input_ids": full_ids, "labels": labels}


class ChatDataset:
    def __init__(self, rows):
        self.rows = rows

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, i):
        return self.rows[i]


def make_trainer_class():
    """
    A Trainer that asks the model for output scores only where we grade.

    The last layer scores every one of ~152k vocabulary entries at every
    position. For a 544-token example that table is bigger than the whole
    model, and we grade only the tutor's ~30 tokens at the end. Since the
    graded tokens are always a suffix (the tutor's turn is last), we ask for
    the tail only. That took peak memory from 4.4 GB to well under the card's
    4 GB. On an older transformers without `logits_to_keep`, it falls back to
    the normal full computation.
    """
    import torch
    import torch.nn.functional as F
    from transformers import Trainer

    class TailLossTrainer(Trainer):
        def compute_loss(self, model, inputs, return_outputs=False, num_items_in_batch=None):
            labels = inputs["labels"]
            input_ids = inputs["input_ids"]
            attention_mask = inputs["attention_mask"]
            graded = labels != -100
            length = labels.shape[1]
            k = int(graded[0].sum().item())
            suffix = (
                labels.shape[0] == 1 and k > 0
                and bool(graded[0, length - k:].all())
                and not bool(graded[0, :length - k].any())
            )
            if suffix:
                try:
                    out = model(input_ids=input_ids, attention_mask=attention_mask, logits_to_keep=k + 1)
                    # Position p predicts token p+1: the last k+1 scores, minus the
                    # final one, line up with the k graded tokens.
                    logits = out.logits[:, :-1, :].float()
                    target = labels[:, length - k:]
                    loss = F.cross_entropy(
                        logits.reshape(-1, logits.size(-1)), target.reshape(-1), ignore_index=-100
                    )
                    return (loss, out) if return_outputs else loss
                except TypeError:
                    pass
            out = model(input_ids=input_ids, attention_mask=attention_mask, labels=labels)
            return (out.loss, out) if return_outputs else out.loss

    return TailLossTrainer


def make_collator(pad_id):
    import torch

    def collate(batch):
        width = max(len(b["input_ids"]) for b in batch)
        ids, labels, mask = [], [], []
        for b in batch:
            pad = width - len(b["input_ids"])
            ids.append(b["input_ids"] + [pad_id] * pad)
            labels.append(b["labels"] + [-100] * pad)
            mask.append([1] * len(b["input_ids"]) + [0] * pad)
        return {
            "input_ids": torch.tensor(ids),
            "labels": torch.tensor(labels),
            "attention_mask": torch.tensor(mask),
        }

    return collate


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None,
                    help="use only this many examples (default 800 on GPU, 400 on CPU; 0 = all)")
    ap.add_argument("--epochs", type=float, default=1.0)
    ap.add_argument("--lr", type=float, default=2e-4)
    args = ap.parse_args()

    import torch
    from transformers import AutoTokenizer, TrainingArguments
    from peft import LoraConfig, get_peft_model

    device = pick_device()
    if args.limit is None:
        args.limit = 800 if device == "cuda" else 400
        print(f"using --limit {args.limit} (pass --limit 0 for all examples)")
    elif args.limit == 0:
        args.limit = None

    print(f"loading {BASE_MODEL} (first time downloads ~1 GB) ...")
    tokenizer = AutoTokenizer.from_pretrained(BASE_MODEL)
    model = load_model(BASE_MODEL)
    model.to(device)

    # LoRA: instead of changing the 500M existing weights, we bolt a small
    # trainable matrix onto each attention/MLP layer and train only those.
    # r is the "width" of that add-on; 16 is a normal choice. This is why the
    # whole run fits on a 4 GB card: the base model is read-only.
    lora = LoraConfig(
        r=16,
        lora_alpha=32,
        lora_dropout=0.05,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        task_type="CAUSAL_LM",
    )
    model = get_peft_model(model, lora)
    model.print_trainable_parameters()

    # Recompute activations during the backward pass instead of storing them.
    # Slower per step, much less memory — the trade that makes 4 GB enough.
    # Only active in training mode, which Trainer sets; made explicit here so
    # a quick probe outside Trainer measures the real thing.
    model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    model.enable_input_require_grads()
    model.config.use_cache = False
    model.train()

    raw = load_examples(DATA / "train.jsonl", args.limit)
    rows = [t for t in (tokenize(tokenizer, r) for r in raw) if t]
    print(f"examples: {len(rows)} usable of {len(raw)} (skipped {len(raw) - len(rows)} over {MAX_LEN} tokens)")
    lengths = sorted(len(r["input_ids"]) for r in rows)
    print(f"tokens per example: median {lengths[len(lengths)//2]}, max {lengths[-1]}")

    OUT.mkdir(parents=True, exist_ok=True)
    targs = TrainingArguments(
        output_dir=str(OUT / "checkpoints"),
        per_device_train_batch_size=1,
        gradient_accumulation_steps=8,   # 8 examples per weight update
        num_train_epochs=args.epochs,
        learning_rate=args.lr,
        warmup_steps=10,
        lr_scheduler_type="cosine",
        logging_steps=10,
        save_strategy="no",
        report_to=[],
        fp16=False, bf16=False,          # the M2200 has no fast half-precision
        dataloader_pin_memory=False,
        remove_unused_columns=False,
    )

    trainer = make_trainer_class()(
        model=model,
        args=targs,
        train_dataset=ChatDataset(rows),
        data_collator=make_collator(tokenizer.pad_token_id),
    )

    print("\ntraining. The number to watch is 'loss' — it should fall over time.\n")
    t0 = time.time()
    trainer.train()
    print(f"\ndone in {(time.time() - t0) / 60:.1f} min")

    adapter_dir = OUT / "adapter"
    model.save_pretrained(str(adapter_dir))
    tokenizer.save_pretrained(str(adapter_dir))
    print(f"saved adapter to {adapter_dir}")

    # A quick taste, on a held-out example the model never saw in training.
    test = load_examples(DATA / "test.jsonl", 1)[0]["messages"][:-1]
    model.eval()
    model.gradient_checkpointing_disable()
    model.config.use_cache = True  # generation is many times faster with the cache
    ids = torch.tensor([chat_ids(tokenizer, test, add_generation_prompt=True)]).to(device)
    with torch.inference_mode():
        out = model.generate(ids, max_new_tokens=120, do_sample=True, temperature=0.6, top_p=0.9)
    print("\n--- sample reply on an unseen test dialogue ---")
    print(tokenizer.decode(out[0][ids.shape[1]:], skip_special_tokens=True).strip())
    print("\nNext: python model/serve.py    (then point the extension at it)")


if __name__ == "__main__":
    main()
