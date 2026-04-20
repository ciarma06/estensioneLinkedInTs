---
name: Language Selection for AI Messages
overview: Aggiungerò una selezione lingua nel sidepanel CRM, salverò la preferenza in `chrome.storage.local`, passerò `targetLanguage` nella invoke frontend e aggiornerò la Edge Function per forzare output nella lingua richiesta, con tono business-casual quando la lingua è inglese.
todos:
  - id: settings-language-key
    content: Aggiungere key, tipo e getter lingua in userSettings.ts
    status: pending
  - id: sidepanel-language-select
    content: Inserire select lingua in sidepanel.html + wiring in crm.ts + stile CSS
    status: pending
  - id: invoke-target-language
    content: Passare targetLanguage in messageGenerator.ts nella invoke
    status: pending
  - id: edge-function-language
    content: Gestire targetLanguage e system prompt dinamico in generate-message/index.ts
    status: pending
  - id: verify-and-remind-deploy
    content: Verifica rapida e reminder deploy funzione Supabase
    status: pending
isProject: false
---

# Piano implementazione lingua messaggi

## 1) Persistenza impostazione lingua (frontend settings)

- Estendere `[src/moduli/userSettings.ts](c:/Users/david/Desktop/progettoLinkedin/estensioneLinkedInTs/src/moduli/userSettings.ts)` con:
  - chiave storage dedicata (es. `ln_user_target_language`)
  - tipo/union per lingue supportate: Italiano, Inglese, Spagnolo, Tedesco
  - helper `getTargetLanguage()` con fallback stabile (es. Italiano)

## 2) UI sidepanel CRM: menu a tendina lingua

- Aggiornare `[sidepanel.html](c:/Users/david/Desktop/progettoLinkedin/estensioneLinkedInTs/sidepanel.html)` aggiungendo una `select` per la lingua nell’area impostazioni AI.
- Aggiornare `[src/moduli/crm.ts](c:/Users/david/Desktop/progettoLinkedin/estensioneLinkedInTs/src/moduli/crm.ts)` per:
  - caricare lingua salvata all’avvio (`DOMContentLoaded`)
  - salvare lingua in `chrome.storage.local` al click su Salva
  - mantenere compatibilità col salvataggio della value proposition nella stessa action
- Aggiornare `[src/style.css](c:/Users/david/Desktop/progettoLinkedin/estensioneLinkedInTs/src/style.css)` con stile leggero della `select` coerente con `.crm-settings`.

## 3) Passaggio lingua alla generazione messaggio

- Aggiornare `[src/moduli/messageGenerator.ts](c:/Users/david/Desktop/progettoLinkedin/estensioneLinkedInTs/src/moduli/messageGenerator.ts)`:
  - recuperare `targetLanguage` dallo storage tramite nuovo helper
  - includere `targetLanguage` nel `body` della `supabase.functions.invoke('generate-message', ...)`

## 4) Backend Edge Function: input + prompt dinamico

- Aggiornare `[supabase/functions/generate-message/index.ts](c:/Users/david/Desktop/progettoLinkedin/estensioneLinkedInTs/supabase/functions/generate-message/index.ts)`:
  - estendere `GenerateBody` con `targetLanguage`
  - validare/normalizzare il valore (accettando solo le 4 lingue previste)
  - costruire `system` prompt dinamico includendo:
    - `IMPORTANTE: Scrivi il messaggio finale esclusivamente in ${targetLanguage}. Non aggiungere introduzioni o commenti, restituisci solo il corpo del messaggio.`
  - aggiungere regola condizionale per inglese:
    - tono “Business Casual” stile Silicon Valley, diretto, pragmatico, orientato ai risultati, evitando inglese scolastico quando la value proposition è in italiano.

## 5) Verifica rapida

- Controllare flusso end-to-end:
  - cambio lingua nel sidepanel e persistenza dopo riapertura
  - payload frontend con `targetLanguage`
  - output modello nella lingua scelta
- Controllo lint sui file toccati.

## 6) Nota deploy

- A fine modifiche, reminder esplicito: fare deploy della Edge Function `generate-message`.

