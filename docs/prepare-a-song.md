# 2. Prepare a song

[Back to the tutorials](index.md) · Previous: [Quick start](quick-start.md) · Next: [Mixing](mixing.md)

A song is a folder. Only the audio is required; two optional text files add names, tempo and a score.

```
my-song/
  01_piano.flac
  02_violin.flac
  03_cello.flac
  song.json
  tune.abc
```

## The stems

| | |
|---|---|
| Formats | WAV, FLAC, MP3, OGG, Opus, M4A, AAC, AIFF (whatever your browser decodes) |
| Recommended | 24-bit WAV or FLAC, all at one sample rate (48 kHz or 44.1 kHz) |
| Start | Every stem starts at time 0 of the song, unless `song.json` gives it an `offset` |
| Length | Stems may have different lengths |

Why 24-bit: single stems are often quiet, and they get pushed up by faders and added together. The noise floor of a 16-bit file sits about 96 dB below full scale, which is close enough to a quiet stem to matter. 16-bit is fine for a finished mix that is only listened to.

The desk runs at the sample rate of the first WAV or FLAC stem it loads (44.1 to 96 kHz), so your stems are not resampled and the export has the same rate.

Silence at the head and tail of a stem costs no memory: the desk keeps only the part that sounds and remembers where it belongs.

Without `song.json` the tracks are named after their files, listed in alphabetical order, and there is no metronome because the tempo is unknown. Number your files (`01_`, `02_`) to control the order.

## song.json

```json
{
  "title": "My song",
  "bpm": 78,
  "meter": "6/4",
  "firstDownbeat": 1.7692,
  "abc": "tune.abc",
  "scoreStart": 1.0,
  "sections": [
    { "name": "Line 1", "time": 1.769 },
    { "name": "Line 2", "time": 11.0 }
  ],
  "tracks": [
    { "file": "melody.wav", "name": "Melody", "group": "Lead", "gainDb": -8, "pan": 0 },
    { "file": "bass.wav", "name": "Bass", "group": "Rhythm", "gainDb": -11, "pan": 0.1 }
  ]
}
```

Every field is optional.

### Song

| Field | Meaning |
|---|---|
| `title` | Shown in the top bar and used for the export file name |
| `bpm`, `meter`, `firstDownbeat` | A steady tempo grid. `firstDownbeat` is the time in seconds of the first beat 1; beats before it are a pick-up |
| `beats` | Use instead of `bpm` when the tempo is not steady: a list of `[time, bar, beat]`, one entry per beat |
| `sections` | Named points in the song: `{ "name": "...", "time": seconds }`. They become buttons, labels on the overview, and loop ranges |

The beat grid drives the metronome, the bar and beat display, beat stepping, loop snapping and the score cursor. If the performance speeds up and slows down, give `beats`; everything then follows the real timing.

### Tracks

| Field | Meaning |
|---|---|
| `file` | File name of the stem. Tracks appear in the order listed; files not listed follow alphabetically |
| `name` | The name on the strip |
| `group` | Tracks with the same group share a colour and sit together. The first four groups with two or more tracks get a DCA each |
| `gainDb`, `pan`, `mute` | Starting fader level in dB, pan from -1 (left) to 1 (right), and mute |
| `offset` | Seconds to delay this stem |

### Score

| Field | Meaning |
|---|---|
| `abc` | File name of the ABC score. Any `.abc` file in the folder is used if this is left out |
| `scoreStart` | The time in seconds at which the first note of the score sounds. Defaults to the first beat |
| `scoreRepeats` | If the score is one verse that the recording plays several times: the number of passes, or `true` for endless |
| `scoreBeats` | The length of one pass in beats. `scoreLength` in seconds is accepted instead |

## The ABC score

[ABC notation](https://abcnotation.com/) is a plain-text way to write music. A minimal file:

```
X:1
M:6/4
L:1/4
Q:1/4=78
K:G
D | "G"G2 (B/G/) "G7"B2 A | "C"G2 E "G"D z D |
```

The desk draws it on the display and moves a cursor through it in time with the beat grid. Title and composer lines are not drawn, because the song title is already at the top of the page.

Line breaks in the file decide the lines on screen. If they do not suit your screen, the desk can lay the score out again: see [Rehearsing with the score](rehearsal.md).
