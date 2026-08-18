# whisper_large_v3 (Triton Python Backend)

This model serves `openai/whisper-large-v3` through Triton.

## Input contract

- `audio_b64` (`TYPE_STRING`, shape `[batch, 1]`): base64-encoded **PCM16 WAV** bytes.
- `task` (`TYPE_STRING`, shape `[batch, 1]`): `transcribe` or `translate`.
- `language` (`TYPE_STRING`, shape `[batch, 1]`): optional language code like `en`, `ur`, `de`.

## Output contract

- `text` (`TYPE_STRING`, shape `[batch, 1]`): transcription result.

## Quick infer example

`POST /v2/models/whisper_large_v3/infer`

```json
{
  "inputs": [
    {
      "name": "audio_b64",
      "datatype": "BYTES",
      "shape": [1, 1],
      "data": ["<base64_pcm16_wav>"]
    },
    {
      "name": "task",
      "datatype": "BYTES",
      "shape": [1, 1],
      "data": ["transcribe"]
    },
    {
      "name": "language",
      "datatype": "BYTES",
      "shape": [1, 1],
      "data": ["en"]
    }
  ],
  "outputs": [{ "name": "text" }]
}
```
