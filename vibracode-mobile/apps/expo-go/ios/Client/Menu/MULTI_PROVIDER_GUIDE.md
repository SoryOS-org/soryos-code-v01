# iOS model selector — multi-provider update guide

Expo Go's native Menu renders the model picker in
`EXPreviewZoomManager+BottomBar.m` (the `Agent model catalog` block around
line 208). This guide documents the change to add **Mistral AI** and align it
with the new backend engine. Editing the Obj-C files must be done and verified
from an Xcode build — we only document it here because this CI environment
cannot compile the iOS app.

## What changed in the backend

The engine no longer requires a CLI inside the E2B sandbox
(`vibracode-backend/lib/providers/`, default `AGENT_ENGINE=provider`):

- **OpenRouter** free models → default `openrouter/free`
- **Mistral AI** official API → default `mistral-large-latest`
- **Google Gemini** official API → default `gemini-2.5-flash`

The iOS app only stores a model id in `NSUserDefaults` under the legacy key
`SelectedClaudeModel` and sends it to the backend. **Nothing on the iOS side
selects the engine** — the backend chooses it from the model id. So adding
Mistral models to the native picker is purely additive: no protocol/billing
changes reach the phone.

## Steps

1. Add a `MistralModelList(void)` function mirroring the web catalogue in
   `vibracode-backend/lib/models.ts` (export `MISTRAL_MODELS`):

```objc
static NSArray<NSDictionary *> *MistralModelList(void) {
  return @[
    @{@"id" : @"mistral-large-latest", @"name" : @"Mistral Large"},
    @{@"id" : @"mistral-medium-latest", @"name" : @"Mistral Medium"},
    @{@"id" : @"mistral-small-latest", @"name" : @"Mistral Small"},
    @{@"id" : @"devstral-small-latest", @"name" : @"Devstral Small"},
    @{@"id" : @"devstral-medium-latest", @"name" : @"Devstral Medium"},
    @{@"id" : @"codestral-latest", @"name" : @"Codestral"},
    @{@"id" : @"ministral-8b-latest", @"name" : @"Ministral 8B"},
    @{@"id" : @"open-mistral-nemo", @"name" : @"Mistral NeMo"},
  ];
}
```

2. Teach `IsKnownAgentModel` about Mistral so persisted ids migrate instead of
   being reset:

```objc
for (NSDictionary *model in MistralModelList()) {
  if ([model[@"id"] isEqualToString:modelId]) {
    return YES;
  }
}
```

3. Add the submenu in `BuildAgentModelMenu`:

```objc
UIMenu *mistralMenu = [UIMenu menuWithTitle:@"Mistral AI"
                                      image:[UIImage systemImageNamed:@"cloud"]
                                 identifier:@"mistral"
                                    options:0
                                   children:BuildModelActions(MistralModelList(),
                                                              selectedModel, handler)];
// ...and add `mistralMenu` to the outer menu's children.
```

4. Keep the comment on line 210 in sync ("Keep in sync with
   `vibracode-backend/lib/models.ts`").

## Notes

- **Do not** add API keys to the iOS app. `MISTRAL_API_KEY`,
  `OPENROUTER_API_KEY` and `GEMINI_API_KEY` stay server-side in
  `vibracode-backend/.env.local` (see `.env.example`).
- The OpenRouter and Gemini lists above are the *existing* ones — they now feed
  the native engine instead of the CLIs. No model ids changed, so already
  released clients keep working.
- Server-side engine selection: `vibracode-backend/lib/providers/registry.ts`
  → `resolveEngine()`. `AGENT_ENGINE=cli` restores the legacy CLI behaviour.