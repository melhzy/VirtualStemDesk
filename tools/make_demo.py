#!/usr/bin/env python3
"""Generate the demo song for Virtual Stem Desk: three synthesized stems of the traditional
tune NEW BRITAIN (public domain), one stanza, G major, 6/4, 78 bpm.  Only numpy and the
standard library are needed.  Everything is synthesized here; no recordings or samples."""
import json, wave, os
import numpy as np

SR, BPM, OFFSET = 22050, 78.0, 1.0            # OFFSET: seconds before the pick-up note
BEAT = 60.0 / BPM
OUT = os.path.join(os.path.dirname(__file__), "..", "demo")

# (midi, beats); None = rest.  Pick-up, then 8 bars of 6/4.
D4, E4, G4, A4, B4, D5 = 62, 64, 67, 69, 71, 74
MELODY = [(D4, 1), (G4, 2), (B4, .5), (G4, .5), (B4, 2), (A4, 1), (G4, 2), (E4, 1), (D4, 1), (None, 1),
          (D4, 1), (G4, 2), (B4, .5), (G4, .5), (B4, 2), (A4, 1), (D5, 4), (None, 1),
          (B4, 1), (D5, 1.5), (B4, .5), (D5, .5), (B4, .5), (G4, 2), (D4, 1), (E4, 1.5), (G4, .5), (G4, .5), (E4, .5), (D4, 1), (None, 1),
          (D4, 1), (G4, 2), (B4, .5), (G4, .5), (B4, 2), (A4, 1), (G4, 4), (None, 2)]
# chords per half bar (3 beats), starting at the first downbeat: (root midi, triad intervals)
MAJ, MIN = (0, 4, 7), (0, 3, 7)
CHORDS = [(55, MAJ), (55, MAJ), (48, MAJ), (55, MAJ), (55, MAJ), (50, MAJ), (55, MAJ), (50, MAJ),
          (55, MAJ), (55, MAJ), (48, MAJ), (55, MAJ), (52, MIN), (50, MAJ), (48, MAJ), (55, MAJ)]

def hz(m): return 440.0 * 2 ** ((m - 69) / 12)

def tone(freq, dur, partials, attack, release):
    n = int(dur * SR); t = np.arange(n) / SR
    y = sum(a * np.sin(2 * np.pi * freq * (k + 1) * t) for k, a in enumerate(partials))
    env = np.minimum(1, t / attack) * np.minimum(1, (dur - t) / release) * np.exp(-t * 0.6)
    return y * env

def render(events, total):
    buf = np.zeros(int(total * SR) + SR)
    for start, freq, dur, partials, attack, release, gain in events:
        y = tone(freq, dur, partials, attack, release) * gain; i = int(start * SR); buf[i:i + len(y)] += y
    return buf[:int(total * SR)]

def write(name, x):
    x = x / max(1e-9, np.abs(x).max()) * 0.7
    with wave.open(os.path.join(OUT, name), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes((x * 32767).astype("<i2").tobytes())

total = OFFSET + (sum(b for _, b in MELODY)) * BEAT + 2.0
mel, t = [], OFFSET
for m, b in MELODY:
    if m is not None: mel.append((t, hz(m), b * BEAT * 0.98, (1, .45, .2, .08), 0.02, 0.08, 1.0))
    t += b * BEAT
down = OFFSET + BEAT                      # first downbeat (after the one-beat pick-up)
pad, bass = [], []
for i, (root, tri) in enumerate(CHORDS):
    s = down + i * 3 * BEAT
    for iv in tri: pad.append((s, hz(root + iv), 3 * BEAT, (1, .25, .1), 0.25, 0.4, 0.5))
    bass.append((s, hz(root - 12), 3 * BEAT * 0.95, (1, .5, .15), 0.01, 0.15, 1.0))
os.makedirs(OUT, exist_ok=True)
write("melody.wav", render(mel, total)); write("chords.wav", render(pad, total)); write("bass.wav", render(bass, total))

abc = """X:1
T:New Britain (demo)
C:Traditional
M:6/4
L:1/4
Q:1/4=78
K:G
D | "G"G2 (B/G/) "G7"B2 A | "C"G2 E "G"D z D | "G"G2 (B/G/) "D7"B2 A | "G"d3- "D7"d z
B | "G"(d3/2 B/) (d/B/) "G7"G2 D | "C"(E3/2 G/) (G/E/) "G"D z D | "Em"G2 (B/G/) "G"B2 "D"A | "C/G"G3- "G"G z z |]
"""
open(os.path.join(OUT, "tune.abc"), "w").write(abc)
song = {
    "title": "New Britain (demo)",
    "bpm": BPM, "meter": "6/4",
    "firstDownbeat": round(down, 4), "pickupBeats": 1,
    "abc": "tune.abc", "scoreStart": OFFSET,
    "sections": [{"name": "Pick-up", "time": OFFSET}, {"name": "Line 1", "time": round(down, 3)},
                 {"name": "Line 2", "time": round(down + 12 * BEAT, 3)}, {"name": "Line 3", "time": round(down + 24 * BEAT, 3)},
                 {"name": "Line 4", "time": round(down + 36 * BEAT, 3)}],
    "tracks": [
        {"file": "melody.wav", "name": "Melody", "group": "Lead", "gainDb": -8, "pan": 0},
        {"file": "chords.wav", "name": "Chords", "group": "Harmony", "gainDb": -14, "pan": -0.2},
        {"file": "bass.wav", "name": "Bass", "group": "Rhythm", "gainDb": -11, "pan": 0.1}],
}
json.dump(song, open(os.path.join(OUT, "song.json"), "w"), indent=2)
print("demo written:", round(total, 2), "s")
