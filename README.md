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
git tag v0.0.2
git push origin v0.0.2
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
code --install-extension socratic-tutor-poc-0.0.1.vsix
```

### About automatic updates

There is no way to make VS Code auto-update an extension that lives on GitHub.
Silent background updates only happen for extensions published to the VS Code
Marketplace, which needs a publisher account and a public listing. Everything
else means installing a new `.vsix` by hand.

For anyone actively editing the extension, none of this matters — use `F5`,
which loads the working copy directly and needs no install at all.

## Using it

Open the panel, paste code into the first box and the error into the second,
press the button, then answer the tutor's question in the reply box. `Enter`
sends, `Shift+Enter` makes a new line. Both boxes start small and grow as you
type, up to a ceiling, after which they scroll.

### The three modes

Pick one from the row at the top of the panel. It can be changed at any time,
including part-way through a conversation — which is the realistic path: start
on Hint, drop to Direct answer when genuinely stuck.

| Mode | What comes back | Guardrail |
|---|---|---|
| **Hint** | A question, nothing else. You locate the line yourself. | On |
| **Strong hint** | A question, plus the offending lines highlighted in your code. | On |
| **Direct answer** | The bug named plainly, and a fix you can apply to the editor in one click. | Off |

Direct answer is the mode that contradicts the project's own thesis, and it is
here on purpose: it gives the evaluation a control condition. Running one bug
through all three modes is the clearest way to show what the Socratic
constraint actually costs and buys.

The guardrail never runs in Direct answer mode — it would block the mode's
entire reason for existing. It always runs in the other two, whatever
`guardrailEnabled` says.

### Applying a fix

Direct answer replies carry a fix card. **Apply to editor** searches your open
editors for the exact lines it means to replace and rewrites them in place;
`Ctrl+Z` undoes it like any other edit. It refuses, and says why, when those
lines are not open, or appear more than once in the file. **Copy** always
works.

### Testing it offline

To see the guardrail fire, type `/leak` as a reply — the mock backend will
deliberately hand over a full solution, and the filter will intercept it.

The mock backend is canned: it replies from a fixed script for each mode,
regardless of what you paste. It is written for `samples/wrong_average.py`, so
paste that one to see coherent replies. Against anything else it will be
confidently irrelevant. Replies start responding to your real code once a model
is connected.

### Commands

| Command | What it does |
|---|---|
| `Socratic Tutor: Open` | Opens the panel |
| `Socratic Tutor: New Session` | Clears the conversation and stats |
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
   | `socraticTutor.model` | `llama-3.3-70b-versatile` |

4. Run **Socratic Tutor: Test Connection**. It sends one throwaway message and
   reports the exact problem if there is one.

For something lighter and faster, `llama-3.1-8b-instant` also works. Model ids
rotate — if you get a 404, check the provider's current model list rather than
trusting the table above.

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
