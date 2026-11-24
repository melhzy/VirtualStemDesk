# 6. Questions and limits

[Back to the tutorials](index.md) · Previous: [MIDI control](midi.md)

## Is my audio uploaded?

No. The page reads the files you give it and decodes and mixes them inside the browser tab. There is no server component. You can save the page and run it with no network connection.

## How much memory does a song need?

Decoded audio is held in memory as 32-bit floating point, whatever the file format. That is about 23 MB per stereo minute per stem at 48 kHz. Silence at the head and tail of each stem (below -120 dBFS) is not kept. As a guide, 22 stereo stems of a three-and-a-half-minute song, half of them silent for part of it, take about 1 GB.

## What sample rate and bit depth does it use?

The desk runs at the sample rate of the first WAV or FLAC stem loaded, from 44.1 to 96 kHz. Stems at other rates are converted to it. Mixing is done in 32-bit float, so intermediate levels above full scale do not clip; only the main output matters. The export is a 24-bit WAV at the desk's sample rate.

## Why does the compressor change the level when I switch it on?

The compressor is the browser's built-in one, and it applies some make-up gain of its own. Use **Trim** and the channel meter to match the level with it on and off.

## The score cursor is not with the music

Check `scoreStart` in `song.json`: it is the time at which the first note of the score sounds, including a pick-up note. If the tempo of the recording is not steady, give a `beats` list instead of `bpm`. If the score is one verse played several times, set `scoreRepeats` and `scoreBeats`.

## The Load demo button says it cannot fetch

You opened `index.html` straight from disk. Browsers do not let such a page fetch files. Drop the `demo` folder onto the page instead, or serve the folder with `python3 -m http.server`.

## What is not there yet

- Slower speeds lower the pitch; there is no time-stretching.
- No noise gate, no effects sends or reverb, no mute groups.
- MIDI is input only.
- The export has no limiter. If it reports clipping, lower the main fader or choose an export loudness target.
- Internal silences in a stem are kept in memory; only the head and tail are trimmed.

## Reporting a problem

Open an issue at <https://github.com/melhzy/VirtualStemDesk/issues> with the browser name and version, what you did, and what the status line said.
