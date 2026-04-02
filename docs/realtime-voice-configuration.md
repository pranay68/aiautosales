# Realtime Voice Configuration

## Goal

Configure Azure OpenAI GPT Realtime for outbound sales calls with:

- natural male-presenting voice
- strong transcription quality
- low interruption rate
- bounded response length
- phone-call-friendly audio settings

## Recommended Default

- `voice`: `ash`
- `turn_detection`: `semantic_vad`
- `vad_eagerness`: `low`
- `interrupt_response`: `false`
- `create_response`: `true`
- `input_audio_transcription.model`: `gpt-4o-mini-transcribe`
- `input_audio_noise_reduction.type`: `near_field`
- `temperature`: `0.7`
- `max_response_output_tokens`: `220`
- `input_audio_format`: `pcm16`
- `output_audio_format`: `pcm16`

## Why This Setup

### Voice

Use `ash` as the default male-presenting voice.

Reason:

- it fits the currently documented realtime voice configuration surface
- it is a better default for a human-like outbound sales rep than generic fallback choices

Inference:

- of the documented realtime-compatible voices, `ash` and `echo` are the strongest male-presenting candidates
- `ash` is the default choice in this repo

### Turn Detection

Use `semantic_vad` with `low` eagerness.

Reason:

- sales calls punish premature interruption
- lower eagerness reduces the chance the model cuts off the prospect
- semantic turn detection is better aligned to conversation boundaries than pure raw thresholding

### Interrupt Response

Set `interrupt_response=false`.

Reason:

- on PSTN calls, frequent interruption creates a robotic feel
- sales calls benefit from more conservative response behavior

### Transcription

Use `gpt-4o-mini-transcribe` for input transcription.

Reason:

- it improves transcript quality and tool context
- the speaking agent should reason over better transcripts, not raw PSTN noise

### Noise Reduction

Use `near_field`.

Reason:

- outbound calling setups are commonly headset or handset style
- near-field noise reduction is the safer starting point for agent-side capture quality

### Temperature

Use `0.7`.

Reason:

- lower values can sound too rigid
- higher values can drift and overtalk
- `0.7` is a good midpoint for conversational persuasion without excessive randomness

### Max Output Tokens

Use `220`.

Reason:

- keeps the model from rambling
- encourages short turns and one-question-at-a-time behavior

## Environment Variables

These settings are controlled through `.env`:

- `AZURE_OPENAI_REALTIME_VOICE`
- `AZURE_OPENAI_REALTIME_TEMPERATURE`
- `AZURE_OPENAI_REALTIME_MAX_OUTPUT_TOKENS`
- `AZURE_OPENAI_REALTIME_INPUT_TRANSCRIPTION_MODEL`
- `AZURE_OPENAI_REALTIME_INPUT_TRANSCRIPTION_LANGUAGE`
- `AZURE_OPENAI_REALTIME_TURN_DETECTION`
- `AZURE_OPENAI_REALTIME_VAD_EAGERNESS`
- `AZURE_OPENAI_REALTIME_SERVER_VAD_THRESHOLD`
- `AZURE_OPENAI_REALTIME_SERVER_VAD_PREFIX_PADDING_MS`
- `AZURE_OPENAI_REALTIME_SERVER_VAD_SILENCE_MS`
- `AZURE_OPENAI_REALTIME_INTERRUPT_RESPONSE`
- `AZURE_OPENAI_REALTIME_CREATE_RESPONSE`
- `AZURE_OPENAI_REALTIME_INPUT_FORMAT`
- `AZURE_OPENAI_REALTIME_OUTPUT_FORMAT`
- `AZURE_OPENAI_REALTIME_NOISE_REDUCTION`

## Current Limitation

The repo now builds a full realtime session config object, but it still does not stream live audio into Azure OpenAI Realtime yet.

That next step is:

- Sonetel session/media bridge
- voice-gateway websocket/session transport
- session update and live tool calls over the realtime connection
