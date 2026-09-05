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


def tokenize(tokenizer, example):
    """
    Turns one chat example into token ids plus a label for each token.

    A label of -100 means "do not grade this token". Everything up to and
    including the tutor's turn header gets -100; only the tutor's actual words
    are graded. That is how "train on the reply, not the student" is expressed.
    """
    messages = example["messages"]
    prompt_ids = tokenizer.apply_chat_template(
        messages[:-1], add_generation_prompt=True, tokenize=True
    )
    full_ids = tokenizer.apply_chat_template(messages, tokenize=True)
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
    ap.add_argument("--limit", type=int, default=None, help="use only this many examples")
    ap.add_argument("--epochs", type=float, default=1.0)
    ap.add_argument("--lr", type=float, default=2e-4)
    args = ap.parse_args()

    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer, Trainer, TrainingArguments
    from peft import LoraConfig, get_peft_model

    device = pick_device()
    if device == "cpu" and args.limit is None:
        args.limit = 400
        print("CPU run: defaulting to --limit 400 so it finishes in reasonable time")

    print(f"loading {BASE_MODEL} (first time downloads ~1 GB) ...")
    tokenizer = AutoTokenizer.from_pretrained(BASE_MODEL)
    model = AutoModelForCausalLM.from_pretrained(BASE_MODEL, torch_dtype=torch.float32)
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
    model.gradient_checkpointing_enable()
    model.enable_input_require_grads()
    model.config.use_cache = False

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

    trainer = Trainer(
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
    ids = tokenizer.apply_chat_template(test, add_generation_prompt=True, return_tensors="pt").to(device)
    with torch.inference_mode():
        out = model.generate(ids, max_new_tokens=120, do_sample=True, temperature=0.6, top_p=0.9)
    print("\n--- sample reply on an unseen test dialogue ---")
    print(tokenizer.decode(out[0][ids.shape[1]:], skip_special_tokens=True).strip())
    print("\nNext: python model/serve.py    (then point the extension at it)")


if __name__ == "__main__":
    main()
