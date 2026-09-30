# Drum kit samples: sources and licenses

Every file in this directory is dedicated to the public domain under
**Creative Commons Zero (CC0 1.0)**:
<https://creativecommons.org/publicdomain/zero/1.0/>. Attribution is not
required. We credit the authors here anyway so the samples can be traced to their source.

Each file is named by its General MIDI drum note number.

| File | GM instrument | Source page (license checked there) | Original file / author | License |
|---|---|---|---|---|
| `36.wav` | Bass Drum 1 (kick) | <https://freesound.org/people/menegass/sounds/100051/> | `Gui_DRUM_BD_hard.wav` by menegass | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `37.wav` | Side Stick | <https://freesound.org/people/KEVOY/sounds/82280/> | `acoustic side stick.wav` by KEVOY | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `38.wav` | Acoustic Snare | <https://freesound.org/people/menegass/sounds/100058/> | `Gui_DRUM_SNARE_hard.wav` by menegass | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `39.wav` | Hand Clap | <https://freesound.org/people/synthnisse/sounds/509526/> | `claps.wav` by synthnisse | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `42.wav` | Closed Hi-Hat | <https://freesound.org/people/menegass/sounds/100053/> | `Gui_DRUM_CC.wav` by menegass | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `44.wav` | Pedal Hi-Hat | <https://freesound.org/people/menegass/sounds/100054/> | `Gui_DRUM_CH.wav` by menegass | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `45.wav` | Low Tom | <https://freesound.org/people/menegass/sounds/100064/> | `Gui_DRUM_TOM_LO_hard.wav` by menegass | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `46.wav` | Open Hi-Hat | <https://freesound.org/people/menegass/sounds/100055/> | `Gui_DRUM_CO.wav` by menegass | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `47.wav` | Low-Mid Tom | <https://freesound.org/people/menegass/sounds/100066/> | `Gui_DRUM_TOM_MID_hard.wav` by menegass | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `49.wav` | Crash Cymbal 1 | <https://freesound.org/people/menegass/sounds/100056/> | `Gui_DRUM_CYN_hard.wav` by menegass | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `50.wav` | High Tom | <https://freesound.org/people/menegass/sounds/100062/> | `Gui_DRUM_TOM_HI_hard.wav` by menegass | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `51.wav` | Ride Cymbal 1 | <https://freesound.org/people/trivialAccapella/sounds/425449/> | `22'' ride hit.aif` by trivialAccapella | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |

The menegass files all come from the freesound pack
[Guigui acoustic drum set](https://freesound.org/people/menegass/packs/6393/).
Most of the kit comes from this one pack so that the pieces sound like a single drum set.

## How the files were obtained and processed

- **menegass and trivialAccapella files (36, 38, 42, 44, 45, 46, 47, 49, 50, 51)**
  came from the FLAC copies in the Sonic Pi repository
  (<https://github.com/sonic-pi-net/sonic-pi/tree/dev/etc/samples>). Sonic Pi
  lightly trims these samples and redistributes them under CC0 with links back to
  the freesound pages above; see its
  [samples README](https://github.com/sonic-pi-net/sonic-pi/blob/dev/etc/samples/README.md).
  We used those copies because freesound requires a login to download originals.
  The Sonic Pi names were `drum_bass_hard`, `drum_snare_hard`,
  `drum_cymbal_closed`, `drum_cymbal_pedal`, `drum_tom_lo_hard`,
  `drum_cymbal_open`, `drum_tom_mid_hard`, `drum_cymbal_hard`,
  `drum_tom_hi_hard`, and `ride_tri`.
- **KEVOY and synthnisse files (37, 39)** came from freesound's public
  high-quality MP3 previews (`cdn.freesound.org/previews/...-hq.mp3`), which
  carry the same CC0 license as the originals.
- All files were converted with ffmpeg to mono, 44.1 kHz, 16-bit PCM WAV, which
  every browser's Web Audio `decodeAudioData` supports. Metadata was stripped, and
  leading silence below -60 dBFS was removed so that hits start on the beat.
- `39.wav` (clap) was raised by 4.8 dB to peak at about -0.5 dBFS so it sits at a similar
  level to the rest of the kit.
- `51.wav` (ride) was cut from 4.7 s to 2.5 s with a 1 s fade-out. This keeps the
  file under ~300 KB, and a step sequencer never lets the full ring-out play anyway.
