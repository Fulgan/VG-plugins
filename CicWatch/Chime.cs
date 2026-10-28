using System;
using Source.Player;
using UnityEngine;

namespace CicWatch
{
    // THE SOUND A CALL MAKES, generated rather than shipped.
    //
    // A sampled asset would need a licence, a file deployed beside the DLL and a loader path that can fail at
    // runtime; a PCM buffer written here needs none of the three. It is the same argument this repo already makes
    // for `Shared/Say.cs`: reproduce the small thing rather than take on a dependency whose failure mode is a
    // throw on a path that has already changed state.
    //
    // TWO GATES THE GAME DOES NOT APPLY FOR US, both read off the assembly rather than assumed:
    //
    //   VOLUME. Every game sound goes through `SoundEmitter`, which routes an `AudioSource` to a mixer group off
    //   its `SoundData`. A source a mod creates has no group and lands on the master bus, so the player's own
    //   effects slider would not touch it. The slider is a PlayerPref, not a mixer read, so scaling by
    //   `GameplayerPrefs.GetSoundEffectVolume()` respects it exactly and needs no mixer at all.
    //
    //   PAUSE. `GameManager.Pause()` sets `Time.timeScale = 0f` and asks `SoundManager` to pause, but that walks
    //   the live emitters and pauses only the LOOPING ones. A one-shot fired over the pause menu therefore plays,
    //   which is the same defect as a toast arriving over one, so the timescale is checked here.
    internal static class Chime
    {
        // A wave legitimately calls ten hulls inside one sweep, and ten pings inside a second is one noise with no
        // information in it. The per-contact rule upstream already stops a hull being announced twice; this stops
        // ten different hulls being announced at once.
        private const float CooldownSeconds = 2f;

        private const int SampleRate = 44100;
        private static AudioSource _src;
        private static AudioClip _clip;
        private static float _lastAt = float.NegativeInfinity;

        /// <summary>Play the call tone, unless something says not to. Safe to call on every match.</summary>
        internal static void Play()
        {
            try
            {
                var cfg = Plugin.Cfg;
                if (cfg == null || !cfg.ChimeEnabled.Value) return;
                // Paused, or a load screen with the clock stopped: a sound here belongs to a game that is running.
                if (Time.timeScale <= 0f) return;
                // `unscaledTime` so the cooldown is real seconds. `time` stops with the clock, and a cooldown that
                // freezes while paused would fire everything held back the moment play resumes.
                var now = Time.unscaledTime;
                if (now - _lastAt < CooldownSeconds) return;

                var vol = Mathf.Clamp01(cfg.ChimeVolume.Value) * Mathf.Clamp01(GameplayerPrefs.GetSoundEffectVolume());
                if (vol <= 0f) return;

                var src = Source();
                if (src == null) return;
                _lastAt = now;
                src.PlayOneShot(Clip(), vol);
            }
            catch (Exception e)
            {
                Plugin.Log.LogWarning("chime: " + e.Message);
            }
        }

        /// <summary>Forget the cooldown, so a preview button is never swallowed by a call a second earlier.</summary>
        internal static void PlayNow()
        {
            _lastAt = float.NegativeInfinity;
            Play();
        }

        private static AudioSource Source()
        {
            if (_src != null) return _src;
            var go = new GameObject("CicWatchChime");
            UnityEngine.Object.DontDestroyOnLoad(go);
            _src = go.AddComponent<AudioSource>();
            _src.playOnAwake = false;
            // 2D: the call is a console alert, not something happening at a position in the world, and a 3D source
            // at the origin fades with the camera.
            _src.spatialBlend = 0f;
            return _src;
        }

        // Two short tones, the second a fifth above the first, with an envelope on each. The envelope is the part
        // that matters: a raw sine switched on and off clicks at both ends, and the click is louder than the tone.
        private static AudioClip Clip()
        {
            if (_clip != null) return _clip;
            const float toneSeconds = 0.09f;
            const float gapSeconds = 0.045f;
            var tone = (int)(SampleRate * toneSeconds);
            var gap = (int)(SampleRate * gapSeconds);
            var data = new float[tone * 2 + gap];

            Fill(data, 0, tone, 880f);
            Fill(data, tone + gap, tone, 1320f);

            _clip = AudioClip.Create("CicWatchChime", data.Length, 1, SampleRate, false);
            _clip.SetData(data, 0);
            return _clip;
        }

        private static void Fill(float[] data, int at, int count, float hz)
        {
            for (var i = 0; i < count; i++)
            {
                var t = (float)i / SampleRate;
                // Linear attack over the first twentieth, then decay to silence: enough to kill the click at both
                // ends without softening the onset into something that reads as a hum.
                var p = (float)i / count;
                var env = p < 0.05f ? p / 0.05f : 1f - (p - 0.05f) / 0.95f;
                data[at + i] = Mathf.Sin(2f * Mathf.PI * hz * t) * env * 0.35f;
            }
        }
    }
}
