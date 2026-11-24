# 5. MIDI control

[Back to the tutorials](index.md) · Previous: [Rehearsing with the score](rehearsal.md) · Next: [Questions and limits](faq.md)

The desk can be driven from a MIDI controller through Web MIDI. Chrome, Edge and Firefox support it; the browser will ask for permission the first time.

Open **More > MIDI control…**. The dialog lists the MIDI inputs it is listening to and shows the last message received, which is the quickest way to check that your controller is connected.

MIDI is input only: the desk does not send fader positions back to the controller.

## Learn mode

Bind any control on your device to a control on the desk.

1. Set the mode to **Learn**.
2. Press **Learn next control**.
3. On the page, touch a fader, or press an **M**, **S**, **Play** or **Stop** key.
4. Move the fader or press the pad on your controller.

The two are now bound. Repeat for each control. A fader on the desk follows a continuous controller (CC) over its full range; a key is pressed by a note-on, or by a CC value of 64 or more.

**Clear all** removes every binding.

## Fader-strip preset

For controllers and mixers that send the fader-strip messages used by Allen & Heath SQ mixers, choose the fader-strip mode. No learning is needed:

| Message | Action on the desk |
|---|---|
| Control change 0 to 31 | Fader of strip 1 to 32 |
| Note 0 to 31 | Mute of strip 1 to 32 |
| Note 32 to 63 | Select strip 1 to 32 |
| Note 64 to 95 | Solo of strip 1 to 32 (the PAFL key on the mixer) |

Strip 1 is the first track on the desk. Any MIDI channel is accepted.

This project is not affiliated with or endorsed by Allen & Heath. The name is used only to describe that message layout.
