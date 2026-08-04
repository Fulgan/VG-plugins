using UnityEngine;

namespace Hypercom
{
    // Turns a QR module grid into something IMGUI can draw.
    //
    // Separate from the encoder because the encoder is game-free and tested off-process; this half is pure
    // Unity and cannot be. Keep it that way — anything with a rule in it belongs on the other side of this line.
    //
    // Texture lifecycle matches `Api.RenderSprite`: a `Texture2D` is an unmanaged allocation that the GC does
    // not reclaim, so it is explicitly destroyed. One texture per pairing session, released when the session
    // closes, and only ever touched on the main thread.
    internal static class QrTexture
    {
        // Big enough that a phone camera resolves the modules from a comfortable distance, small enough for a
        // settings panel: a v3 symbol (29 modules) comes out at 174px plus the quiet zone.
        private const int Scale = 6;

        // The 4-module light border the standard requires. Without it a scanner has nothing to separate the
        // symbol from whatever is behind the window, and reads fail for reasons that look like bad art.
        private const int QuietModules = 4;

        internal static Texture2D Build(bool[,] modules)
        {
            if (modules == null) return null;
            var count = modules.GetLength(0);
            var side = (count + QuietModules * 2) * Scale;

            var tex = new Texture2D(side, side, TextureFormat.RGBA32, mipChain: false)
            {
                // Point filtering and clamping: a QR is not a photograph. Bilinear smoothing softens module
                // edges, which is exactly what a decoder's thresholding step cannot afford.
                filterMode = FilterMode.Point,
                wrapMode = TextureWrapMode.Clamp,
            };

            var pixels = new Color32[side * side];
            var light = new Color32(255, 255, 255, 255);
            var dark = new Color32(0, 0, 0, 255);
            for (var y = 0; y < side; y++)
                for (var x = 0; x < side; x++)
                {
                    var mx = x / Scale - QuietModules;
                    var my = y / Scale - QuietModules;
                    var inside = mx >= 0 && mx < count && my >= 0 && my < count;
                    // Texture rows run bottom-up while the module grid runs top-down, so the row is flipped
                    // here rather than in the encoder — a mirrored QR does not scan.
                    pixels[(side - 1 - y) * side + x] = inside && modules[my, mx] ? dark : light;
                }

            tex.SetPixels32(pixels);
            tex.Apply(updateMipmaps: false);
            return tex;
        }

        internal static void Release(ref Texture2D tex)
        {
            if (tex == null) return;
            Object.Destroy(tex);
            tex = null;
        }
    }
}
