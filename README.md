# Socratic Tutor — proof of concept

A VS Code extension that answers a stuck student with **a question**, never with
the fix. Built for the SIC AI capstone as a working shell to test the idea in.

## What works today

- A panel beside the editor: paste code, paste the error, get a hint, reply, repeat.
- A multi-turn transcript — the Socratic loop is a conversation, not one answer.
- **The Direct Output Filter**: replies containing code or a stated answer are
  caught, the model is asked once to rewrite as a question, and if it fails
  again the student sees a nudge instead of the solution. Every catch is
  counted and its reason logged.
- API keys stored in the OS credential vault, never in settings or the repo.
- A `mock` backend that replies offline, so prompt and UI work costs nothing.
- A live backend for any OpenAI-compatible provider — see *Plugging in a model*.

## What is deliberately missing

No dataset. No knowledge tracing. No RLHF (Reinforcement Learning from Human
Feedback) or DPO (Direct Preference Optimization) training. No evaluation
harness. This is the shell those things plug into.

## Installing it

You do **not** need Node.js. VS Code runs extensions in its own bundled runtime.

### While developing — press F5

1. Open this folder in VS Code.
2. Press `F5`. A second VS Code window opens with the extension loaded.
3. In that window: `Ctrl+Shift+P` → **Socratic Tutor: Open**.

Changes to the code need only `Ctrl+R` in that second window. This is the right
mode for anyone editing the prompt or the guardrail.

### Installing it globally — build a .vsix

VS Code keeps a registry of installed extensions in
`%USERPROFILE%\.vscode\extensions\extensions.json` and loads what that file
lists. Copying or cloning a folder into that directory does **not** install
anything on current versions — the folder is simply ignored. A global install
needs a packaged `.vsix`.

Nobody needs Node.js locally for this: pushing a version tag makes GitHub
Actions build the `.vsix` and attach it to the Release.

```powershell
git tag v0.0.6
git push origin v0.0.6
```

Download `socratic-tutor-poc.vsix` from the Release page, then either drag it
onto the Extensions panel, or:

```powershell
code --install-extension "$env:USERPROFILE\Downloads\socratic-tutor-poc.vsix"
```

Restart VS Code. To update, bump `version` in `package.json`, tag again, and
install the new `.vsix` over the old one. To uninstall, use the Extensions
panel like any other extension.

If you would rather not wait on CI, install Node.js once and build it yourself:

```powershell
npx @vscode/vsce package
code --install-extension socratic-tutor-poc-0.0.6.vsix
```

### About automatic updates

There is no way to make VS Code auto-update an extension that lives on GitHub.
Silent background updates only happen for extensions published to the VS Code
Marketplace, which needs a publisher account and a public listing. Everything
else means installing a new `.vsix` by hand.

For anyone actively editing the extension, none of this matters — use `F5`,
which loads the working copy directly and needs no install at all.

## Using it

1. **Select the code** you are stuck on. Whole lines are used whatever you
   drag, so the numbering the tutor sees matches the editor.
2. **Right-click** and choose **Ask Socratic Tutor**, or press `Ctrl+Alt+S`.
3. A popup appears with three rows. **Type a question** if you have one — or
   leave it empty — then **pick a row** for how much help you want. `Enter`
   picks the highlighted row, which is whichever mode you used last.
4. The side panel opens with the reply. Reply in the box at the bottom to keep
   talking.

There is no error box. The prompt tells the model it has not been told whether
the code runs, and warns it not to assume — an earlier version asserted the code
ran fine, and against code that plainly crashes the model spent its whole reply
arguing with the premise instead of reading line 4.

### The three modes

| Mode | What comes back | Guardrail |
|---|---|---|
| **Hint** | A nudge and a question. You locate the line yourself. | On |
| **Strong hint** | A question, plus the lines highlighted in the editor. | On |
| **Direct answer** | The bug explained, and a fix you can apply in one click. | Off |

The popup sets the mode for a new selection. The row at the top of the panel
changes it for follow-ups, so "I'm stuck, give me a strong hint now" is one
click rather than a re-selection. The mode you used last is remembered across
restarts.

Direct answer contradicts the project's own thesis on purpose: it gives the
evaluation a control condition. Running one bug through all three modes is the
clearest way to show what the Socratic constraint costs and buys.

### Talking to it

The tutor is meant to sound like a patient friend, not an examiner. After the
first reply you can answer its question, ask what a concept means, say you are
confused, guess, say thanks, or wander off-topic — it handles each of those
differently. Asking *what a KeyError is* gets a plain explanation; asking
*where my bug is* in Hint mode still gets a question back. Concepts are always
fair game; only the location and fix of your specific bug is protected.

The model sees the code plus the last eight turns. Older turns drop off, which
keeps a long conversation inside a free tier's limits; the panel keeps the last
ten exchanges for you to scroll.

### Highlighting in the editor

Strong hint and Direct answer light up the offending lines in the editor itself.
The highlight disappears the moment you click anywhere in that file, so it never
sits there stale. **Re-highlight** in the panel puts it back — as does clicking
the line label on any exchange.

Re-highlight refuses if the code has changed since you asked. The old line
numbers would point at something else, and a confidently wrong highlight is
worse than none.

The decoration is deliberately the least assertive thing it could be: a
translucent background, no gutter mark, and none of the inline `before`/`after`
content that inline suggestions use, so it cannot collide with Copilot's ghost
text. VS Code exposes no priority setting for decorations — where two overlap,
the type registered first paints underneath — so ours is created at activation,
which is the only lever the API offers.

### Applying a fix

Direct answer replies carry a fix card. **Apply to editor** writes the fix back
into the exact lines you selected, after checking they have not changed;
`Ctrl+Z` undoes it like any other edit. Afterwards the conversation continues
("why did that work?") but highlighting and a second fix wait for a new
selection, because the line numbers the model was given no longer describe the
file. **Copy** always works.

### The panel

The last 10 exchanges are kept; older ones drop off. Each shows the code you
selected (collapsed automatically when it is long), your question if you added
one, and the reply, each in its own block.

Replies are revealed progressively rather than landing all at once. It is
cosmetic, capped at about a second however long the reply is, and skipped
entirely when the OS asks for reduced motion. Turn it off with
`socraticTutor.typewriter`.

### Free-tier rate limits

Groq's free tier meters input tokens per minute (7,000 for the Qwen model at
the time of writing). Each request carries the system prompt plus the code plus
the conversation — roughly 1,300 tokens — so a fast back-and-forth hits the
ceiling after five or six turns. When the provider says to wait a few seconds,
the extension waits and retries once on its own; you will notice a pause, not
an error. A longer limit surfaces as a 429 in the panel with the provider's
own message.

### Testing it offline

Type `/leak` as a reply to force a guardrail-tripping response from the mock
backend. The mock replies from a fixed script per mode regardless of what you
select; it is written for `samples/wrong_average.py`.

### Commands

| Command | What it does |
|---|---|
| `Ask Socratic Tutor` | The main one. Needs a selection; on the right-click menu and `Ctrl+Alt+S` |
| `Socratic Tutor: Open` | Opens the panel without asking anything |
| `Socratic Tutor: New Session` | Clears the history, the highlight and the stats |
| `Socratic Tutor: Show Session Stats` | Prints guardrail counts to the Output panel |
| `Socratic Tutor: Set API Key` | Stores a provider key in the OS vault |
| `Socratic Tutor: Clear API Key` | Removes it |
| `Socratic Tutor: Test Connection` | Sends one throwaway message to check the key, URL and model id |

### Tests

Also runnable without Node, using VS Code's runtime. From this folder, in
PowerShell:

```powershell
$env:ELECTRON_RUN_AS_NODE=1; & "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe" test/smoke.js
```

Covers the guardrail (both what it must catch and what it must not), the mock
backend, and prompt assembly.

## Where to edit

| File | What lives there |
|---|---|
| `prompt.js` | **The system prompt.** The actual product. Start here. |
| `guardrail.js` | The filter's rules and thresholds |
| `providers.js` | Backend adapters — where the model gets plugged in |
| `parse.js` | Pulls the `LINES:` marker and the fix block out of a reply |
| `extension.js` | Panel lifecycle, conversation state, stats |
| `media/` | The panel's HTML, CSS and browser-side script |

Reload the second window with `Ctrl+R` after editing to pick up changes.

## Plugging in a model

The `openaiCompatible` adapter is wired and works with any provider that accepts
the standard `/chat/completions` request — Groq, Together, OpenRouter, vLLM and
others. Switching between them is three settings, not a code change.

### Recommended: Groq (free tier, no card)

1. Sign in at <https://console.groq.com> and create an API key.
2. In VS Code: `Ctrl+Shift+P` → **Socratic Tutor: Set API Key** → paste it.
   It goes to the Windows Credential Manager, never to a file in this repo.
3. Open Settings (`Ctrl+,`), search `socraticTutor`, and set:

   | Setting | Value |
   |---|---|
   | `socraticTutor.provider` | `openaiCompatible` |
   | `socraticTutor.baseUrl` | `https://api.groq.com/openai/v1` |
   | `socraticTutor.model` | `qwen/qwen3.8-27b` |

4. Run **Socratic Tutor: Test Connection**. It sends one throwaway message and
   reports the exact problem if there is one.

`openai/gpt-oss-120b` also works well. Both were tested against all three modes
and produced correct `LINES:` markers and a correct fix; Qwen's replies were the
more concise of the two, and being open-weight it stays compatible with any
later fine-tuning.

**Model ids rotate, and fast.** Groq retired the whole Llama family between this
project starting and its second week. A 404 from *Test Connection* almost always
means the id, not the key. To see what a provider currently offers:

```powershell
curl -H "Authorization: Bearer YOUR_KEY" https://api.groq.com/openai/v1/models
```

### Other providers

Same three settings, different values:

| Provider | `baseUrl` | Notes |
|---|---|---|
| Groq | `https://api.groq.com/openai/v1` | Free tier, fastest |
| OpenRouter | `https://openrouter.ai/api/v1` | One key, many models — best for comparing |
| Together | `https://api.together.xyz/v1` | Good Qwen coder models |
| Ollama (local) | leave empty | Set provider to `ollama`; no key needed |

Google and Anthropic use different request shapes and would each need their own
adapter function, which is why the adapter layer exists at all.

### A constraint to remember when choosing

**Only open-weight models can be fine-tuned.** If DPO (Direct Preference
Optimization) or RLHF stays in the plan, the final model has to come from the
Llama or Qwen family — the closed hosted models cannot be trained on.

### If something goes wrong

Errors surface in the panel and in the Output panel under *Socratic Tutor*. The
adapter distinguishes a rejected key (401) from a wrong model id (404) from a
rate limit (429), so read the message before changing settings at random.
Setting `socraticTutor.provider` back to `mock` always gets you working again.

## Notes for the team

The guardrail is crude on purpose. A filter whose every rule you can read aloud
is worth more in the write-up than a clever one, because "the filter fired 14
times in 60 turns, here are the reasons" is evidence, and a neural filter's
output is not. Two bugs surfaced while testing it, both instructive:

- The code-line detector was written C-shaped (`if (x) {`) and silently missed
  every Python block. Worth a sentence in the report about testing filters
  against the language you actually target.
- Checking spoiler phrases across the whole reply blocked *"What do you think
  the problem is?"* — the tutor doing its job — because it contains "the problem
  is". Phrases are now checked per sentence, and questions are exempt. This is
  the false-positive/false-negative trade-off your evaluation section will need
  to discuss, showing up on day one.
