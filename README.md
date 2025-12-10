# Voice-Enabled Anki Review Assistant

A minimal system for reviewing Anki cards **by talking**. It reads the
card front aloud, listens to your spoken answer, transcribes it,
evaluates correctness using GPT, generates short feedback, and
progresses based on your grading. The goal is to provide a hands-free,
conversational review experience.

## Features

-   Voice playback of card fronts (TTS)
-   Speech capture + transcription (STT)
-   GPT-generated evaluation and feedback
-   Standard Anki grading (Again/Hard/Good/Easy)
-   Optional back reveal (server handles reveal before grading)
-   Chat-style UI with Markdown output
-   Prefetch TTS for upcoming cards
-   Optional free conversation mode

## Architecture

### Server

-   Node.js / Express
-   AnkiConnect (port 8765)
-   Replicate TTS/STT
-   GPT streaming via SSE
-   Sanitization of note HTML → speakable text

### Client

-   React + Vite
-   TypeScript
-   Audio capture + VAD
-   Markdown UI

## Installation

### Server

    cd server
    npm install
    npm run dev

### Client

    cd client
    npm install
    npm run dev

### Environment Variables

    REPLICATE_API_TOKEN=...
    OPENAI_API_KEY=...

Ensure **AnkiConnect** is running.

## Usage

1.  Start server and client
2.  Select a deck in Anki (active window)
3.  Begin review session
4.  Listen, speak answer, grade, repeat

## Basic Flow

1.  Retrieve card
2.  TTS playback
3.  Record answer
4.  STT transcription
5.  GPT feedback
6.  Grade card
7.  Next card

## API (Simplified)

  Method   Path              Purpose
  -------- ----------------- -----------------
  GET      `/current`        get card
  POST     `/start`          start session
  POST     `/answer`         grade card
  POST     `/tts`            text → audio
  POST     `/stt`            audio → text
  POST     `/review-chain`   full evaluation
  POST     `/convoSend`      free chat

## Notes

-   Grading advances card automatically
-   Back reveal is server-side
-   GPT feedback is short and streamed
-   Cloze fields preserved

## License

MIT
