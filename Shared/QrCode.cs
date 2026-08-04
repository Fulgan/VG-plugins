using System;
using System.Collections.Generic;

namespace VG.Util
{
    // A QR encoder, small on purpose: BYTE mode only, error correction level M, versions 1–6.
    //
    // Why hand-rolled: this compiles into a BepInEx plugin, which takes no NuGet dependency (the game DLLs are
    // referenced straight out of the install), and a pairing QR is the only thing that needs one. Nothing here
    // touches Unity or the game — the output is a `bool[,]` of dark modules, so it is testable off-process and
    // the caller owns turning it into pixels.
    //
    // Scope limits and why they are where they are:
    //   BYTE mode      the payload is a URL with a random code; alphanumeric mode would exclude lowercase.
    //   ECC level M    ~15% recovery, the usual choice for a screen scanned from a phone.
    //   versions 1–6   v6-M holds 106 bytes, which covers `http://<lan-ip>:<port>/#/pair?c=XXXXXXXX`. v7+ adds
    //                  an 18-bit VERSION-INFO block in two corners that this does not emit, so the cap is a
    //                  correctness boundary rather than a size preference: a longer payload returns null.
    //
    // Correctness is pinned by tests that compare every module against the Nayuki reference implementation.
    // A wrong table here still produces a plausible-looking square that scans to the wrong thing — or scans
    // nowhere — so "it looked fine" is not evidence.
    internal static class QrCode
    {
        internal const int MinVersion = 1;
        internal const int MaxVersion = 6;

        // Error-correction codewords per block, and block count, for level M at versions 1–6 (index = version).
        private static readonly int[] EccPerBlock = { -1, 10, 16, 26, 18, 24, 16 };
        private static readonly int[] NumBlocks = { -1, 1, 1, 1, 2, 2, 4 };

        // Level M's own 2-bit code, as it goes into the format field. NOT the ordinal of the level: the
        // standard's order is L=1, M=0, Q=3, H=2.
        private const int FormatEccM = 0;

        // The largest byte-mode payload that fits at MaxVersion. Callers size their payload against this.
        internal static int MaxPayloadBytes => CapacityBytes(MaxVersion);

        // Encode `data` as a QR symbol. Returns `[size, size]` of dark modules, or NULL when the payload does
        // not fit in v6 — never a truncated symbol, because a truncated QR still scans, to the wrong place.
        internal static bool[,] Encode(byte[] data) => Encode(data, -1);

        // `forcedMask` pins the mask (0-7) instead of choosing the lowest-penalty one. -1 = choose. Exists
        // because mask CHOICE is the one part of the format two reference implementations disagree about, so a
        // test can compare structure under a fixed mask and check the chosen one separately.
        internal static bool[,] Encode(byte[] data, int forcedMask)
        {
            if (data == null) return null;
            var version = -1;
            for (var v = MinVersion; v <= MaxVersion; v++)
                if (data.Length <= CapacityBytes(v)) { version = v; break; }
            if (version < 0) return null;

            var codewords = AddEccAndInterleave(BuildDataCodewords(data, version), version);
            var size = 4 * version + 17;
            var modules = new bool[size, size];
            var isFunction = new bool[size, size];

            DrawFunctionPatterns(modules, isFunction, version);
            DrawCodewords(modules, isFunction, codewords);

            // Every mask is drawn, scored and undone; the lowest penalty wins. The standard's rules exist to
            // avoid patterns a scanner mistakes for a finder, so this is not cosmetic.
            var bestMask = forcedMask;
            var bestPenalty = int.MaxValue;
            for (var mask = 0; forcedMask < 0 && mask < 8; mask++)
            {
                ApplyMask(modules, isFunction, mask);
                DrawFormatBits(modules, isFunction, mask);
                var penalty = PenaltyScore(modules);
                if (penalty < bestPenalty) { bestPenalty = penalty; bestMask = mask; }
                ApplyMask(modules, isFunction, mask);   // XOR is its own inverse
            }
            ApplyMask(modules, isFunction, bestMask);
            DrawFormatBits(modules, isFunction, bestMask);
            return modules;
        }

        // ---- capacity ---------------------------------------------------------------------------------

        // Data modules before error correction: the whole grid minus the function patterns. Versions 2+ carry
        // one alignment pattern block; the version-info block (v7+) is outside this encoder's range.
        private static int RawDataModules(int version)
        {
            var result = (16 * version + 128) * version + 64;
            if (version >= 2)
            {
                var numAlign = version / 7 + 2;
                result -= (25 * numAlign - 10) * numAlign - 55;
            }
            return result;
        }

        private static int TotalCodewords(int version) => RawDataModules(version) / 8;

        private static int DataCodewords(int version) =>
            TotalCodewords(version) - EccPerBlock[version] * NumBlocks[version];

        // Byte-mode payload capacity. The header is 4 bits of mode plus an 8-bit length (versions 1–9), so 12
        // bits are gone before any data.
        private static int CapacityBytes(int version) => (DataCodewords(version) * 8 - 12) / 8;

        // ---- bit stream -------------------------------------------------------------------------------

        private static void AppendBits(List<bool> bits, int value, int count)
        {
            for (var i = count - 1; i >= 0; i--)
                bits.Add(((value >> i) & 1) != 0);
        }

        private static byte[] BuildDataCodewords(byte[] data, int version)
        {
            var bits = new List<bool>();
            AppendBits(bits, 0x4, 4);            // byte mode
            AppendBits(bits, data.Length, 8);    // character count (8 bits for versions 1–9)
            foreach (var b in data) AppendBits(bits, b, 8);

            var capacityBits = DataCodewords(version) * 8;
            // Terminator, then pad to a byte boundary, then the standard's alternating pad bytes.
            AppendBits(bits, 0, Math.Min(4, capacityBits - bits.Count));
            AppendBits(bits, 0, (8 - bits.Count % 8) % 8);
            for (var pad = 0xEC; bits.Count < capacityBits; pad ^= 0xEC ^ 0x11)
                AppendBits(bits, pad, 8);

            var result = new byte[bits.Count / 8];
            for (var i = 0; i < bits.Count; i++)
                if (bits[i]) result[i >> 3] |= (byte)(1 << (7 - (i & 7)));
            return result;
        }

        // ---- Reed-Solomon -----------------------------------------------------------------------------

        // Multiply in GF(256) with the QR field's reducing polynomial x^8+x^4+x^3+x^2+1 (0x11D). Russian
        // peasant multiplication, so no log tables to get wrong.
        private static byte FieldMultiply(byte x, byte y)
        {
            var z = 0;
            for (var i = 7; i >= 0; i--)
            {
                z = (z << 1) ^ ((z >> 7) * 0x11D);
                z ^= ((y >> i) & 1) * x;
            }
            return (byte)z;
        }

        // The divisor polynomial for `degree` ECC codewords: (x - r^0)(x - r^1)…, stored without its leading 1.
        private static byte[] ReedSolomonDivisor(int degree)
        {
            var result = new byte[degree];
            result[degree - 1] = 1;
            byte root = 1;
            for (var i = 0; i < degree; i++)
            {
                for (var j = 0; j < result.Length; j++)
                {
                    result[j] = FieldMultiply(result[j], root);
                    if (j + 1 < result.Length) result[j] ^= result[j + 1];
                }
                root = FieldMultiply(root, 0x02);
            }
            return result;
        }

        private static byte[] ReedSolomonRemainder(byte[] data, int start, int length, byte[] divisor)
        {
            var result = new byte[divisor.Length];
            for (var i = start; i < start + length; i++)
            {
                var factor = (byte)(data[i] ^ result[0]);
                Array.Copy(result, 1, result, 0, result.Length - 1);
                result[result.Length - 1] = 0;
                for (var j = 0; j < result.Length; j++)
                    result[j] ^= FieldMultiply(divisor[j], factor);
            }
            return result;
        }

        // Split the data into blocks, append each block's ECC, then interleave — the standard's order, which is
        // what makes a burst of damage fall across several blocks instead of destroying one.
        private static byte[] AddEccAndInterleave(byte[] data, int version)
        {
            var blocks = NumBlocks[version];
            var eccLen = EccPerBlock[version];
            var total = TotalCodewords(version);
            var shortBlockLen = total / blocks - eccLen;   // data codewords in the shorter blocks
            var numShort = blocks - total % blocks;

            var divisor = ReedSolomonDivisor(eccLen);
            var dataBlocks = new byte[blocks][];
            var eccBlocks = new byte[blocks][];
            var offset = 0;
            for (var i = 0; i < blocks; i++)
            {
                var len = shortBlockLen + (i < numShort ? 0 : 1);
                dataBlocks[i] = new byte[len];
                Array.Copy(data, offset, dataBlocks[i], 0, len);
                eccBlocks[i] = ReedSolomonRemainder(data, offset, len, divisor);
                offset += len;
            }

            var result = new byte[total];
            var k = 0;
            // The longer blocks have one extra data codeword; that column is short by `numShort` entries.
            for (var i = 0; i <= shortBlockLen; i++)
                for (var j = 0; j < blocks; j++)
                    if (i < dataBlocks[j].Length) result[k++] = dataBlocks[j][i];
            for (var i = 0; i < eccLen; i++)
                for (var j = 0; j < blocks; j++)
                    result[k++] = eccBlocks[j][i];
            return result;
        }

        // ---- module drawing ---------------------------------------------------------------------------

        private static void Set(bool[,] modules, bool[,] isFunction, int x, int y, bool dark)
        {
            modules[y, x] = dark;
            isFunction[y, x] = true;
        }

        private static void DrawFunctionPatterns(bool[,] modules, bool[,] isFunction, int version)
        {
            var size = modules.GetLength(0);

            // Timing patterns: alternating along row 6 and column 6.
            for (var i = 0; i < size; i++)
            {
                Set(modules, isFunction, 6, i, i % 2 == 0);
                Set(modules, isFunction, i, 6, i % 2 == 0);
            }

            DrawFinder(modules, isFunction, 3, 3);
            DrawFinder(modules, isFunction, size - 4, 3);
            DrawFinder(modules, isFunction, 3, size - 4);

            // Alignment patterns at every coordinate pair except the three that collide with a finder. Versions
            // 2–6 have exactly two coordinates, so this places a single pattern at the bottom-right.
            var coords = AlignmentCoords(version, size);
            for (var i = 0; i < coords.Length; i++)
                for (var j = 0; j < coords.Length; j++)
                {
                    bool first = i == 0, last = i == coords.Length - 1;
                    bool jFirst = j == 0, jLast = j == coords.Length - 1;
                    if ((first && jFirst) || (first && jLast) || (last && jFirst)) continue;
                    DrawAlignment(modules, isFunction, coords[i], coords[j]);
                }

            // Format bits are drawn per mask, but their cells must be reserved now so data skips them.
            DrawFormatBits(modules, isFunction, 0);
        }

        private static int[] AlignmentCoords(int version, int size)
        {
            if (version == 1) return new int[0];
            var num = version / 7 + 2;
            var result = new int[num];
            result[0] = 6;
            for (int i = num - 1, pos = size - 7; i >= 1; i--, pos -= (size - 13) / (num - 1))
                result[i] = pos;
            return result;
        }

        private static void DrawFinder(bool[,] modules, bool[,] isFunction, int cx, int cy)
        {
            var size = modules.GetLength(0);
            // Radius 4 covers the separator ring, which must be light and must be reserved.
            for (var dy = -4; dy <= 4; dy++)
                for (var dx = -4; dx <= 4; dx++)
                {
                    int x = cx + dx, y = cy + dy;
                    if (x < 0 || x >= size || y < 0 || y >= size) continue;
                        var dist = Math.Max(Math.Abs(dx), Math.Abs(dy));
                    Set(modules, isFunction, x, y, dist != 2 && dist != 4);
                }
        }

        private static void DrawAlignment(bool[,] modules, bool[,] isFunction, int cx, int cy)
        {
            for (var dy = -2; dy <= 2; dy++)
                for (var dx = -2; dx <= 2; dx++)
                    Set(modules, isFunction, cx + dx, cy + dy, Math.Max(Math.Abs(dx), Math.Abs(dy)) != 1);
        }

        // The 15-bit format field: 5 data bits (ECC level + mask) with a BCH(15,5) remainder, XORed with the
        // standard's 0x5412 so an all-zero field is still distinguishable. Written twice, in both corners.
        private static void DrawFormatBits(bool[,] modules, bool[,] isFunction, int mask)
        {
            var size = modules.GetLength(0);
            var data = FormatEccM << 3 | mask;
            var rem = data;
            for (var i = 0; i < 10; i++)
                rem = (rem << 1) ^ ((rem >> 9) * 0x537);
            var bits = (data << 10 | rem) ^ 0x5412;

            // Copy 1: around the top-left finder.
            for (var i = 0; i <= 5; i++) Set(modules, isFunction, 8, i, GetBit(bits, i));
            Set(modules, isFunction, 8, 7, GetBit(bits, 6));
            Set(modules, isFunction, 8, 8, GetBit(bits, 7));
            Set(modules, isFunction, 7, 8, GetBit(bits, 8));
            for (var i = 9; i < 15; i++) Set(modules, isFunction, 14 - i, 8, GetBit(bits, i));

            // Copy 2: split between the other two finders, plus the always-dark module above the bottom-left.
            for (var i = 0; i < 8; i++) Set(modules, isFunction, size - 1 - i, 8, GetBit(bits, i));
            for (var i = 8; i < 15; i++) Set(modules, isFunction, 8, size - 15 + i, GetBit(bits, i));
            Set(modules, isFunction, 8, size - 8, true);
        }

        private static bool GetBit(int x, int i) => ((x >> i) & 1) != 0;

        // Codewords go into the non-function modules in a zigzag of two-column strips, right to left, skipping
        // the vertical timing column entirely (column 6 shifts every strip left of it by one).
        private static void DrawCodewords(bool[,] modules, bool[,] isFunction, byte[] codewords)
        {
            var size = modules.GetLength(0);
            var i = 0; // bit index into codewords
            for (var right = size - 1; right >= 1; right -= 2)
            {
                if (right == 6) right = 5;
                for (var vert = 0; vert < size; vert++)
                    for (var j = 0; j < 2; j++)
                    {
                        var x = right - j;
                        var upward = ((right + 1) & 2) == 0;
                        var y = upward ? size - 1 - vert : vert;
                        if (isFunction[y, x] || i >= codewords.Length * 8) continue;
                        modules[y, x] = GetBit(codewords[i >> 3], 7 - (i & 7));
                        i++;
                    }
            }
        }

        private static void ApplyMask(bool[,] modules, bool[,] isFunction, int mask)
        {
            var size = modules.GetLength(0);
            for (var y = 0; y < size; y++)
                for (var x = 0; x < size; x++)
                {
                    if (isFunction[y, x]) continue;
                    bool invert;
                    switch (mask)
                    {
                        case 0: invert = (x + y) % 2 == 0; break;
                        case 1: invert = y % 2 == 0; break;
                        case 2: invert = x % 3 == 0; break;
                        case 3: invert = (x + y) % 3 == 0; break;
                        case 4: invert = (x / 3 + y / 2) % 2 == 0; break;
                        case 5: invert = x * y % 2 + x * y % 3 == 0; break;
                        case 6: invert = (x * y % 2 + x * y % 3) % 2 == 0; break;
                        case 7: invert = ((x + y) % 2 + x * y % 3) % 2 == 0; break;
                        default: throw new ArgumentOutOfRangeException(nameof(mask));
                    }
                    modules[y, x] ^= invert;
                }
        }

        // ---- mask selection ---------------------------------------------------------------------------

        private const int PenaltyN1 = 3, PenaltyN2 = 3, PenaltyN3 = 40, PenaltyN4 = 10;

        // The four penalty rules' contributions separately, so tests can assert each against a grid whose
        // score is computable by hand. A single total hides which rule is wrong, and a wrong rule only shows up
        // as a differently-masked (still scannable) symbol — the kind of fault no eye catches.
        internal static int[] PenaltyParts(bool[,] modules)
        {
            var parts = new int[4];
            PenaltyScore(modules, parts);
            return parts;
        }

        private static int PenaltyScore(bool[,] modules) => PenaltyScore(modules, new int[4]);

        private static int PenaltyScore(bool[,] modules, int[] parts)
        {
            var size = modules.GetLength(0);
            var result = 0;

            // Rule 1: runs of five or more same-coloured modules in a row or column. Rule 3 shares the walk:
            // a finder-like 1:1:3:1:1 pattern with four light modules on either side.
            for (var y = 0; y < size; y++)
            {
                var runColor = false;
                var runLen = 0;
                var history = new int[7];
                for (var x = 0; x < size; x++)
                {
                    if (modules[y, x] == runColor) runLen++;
                    else
                    {
                        FinderPenaltyAddHistory(runLen, history, size);
                        if (!runColor) { var p3 = FinderPenaltyCountPatterns(history) * PenaltyN3; result += p3; parts[2] += p3; }
                        runColor = modules[y, x];
                        runLen = 1;
                    }
                    if (runLen == 5) { result += PenaltyN1; parts[0] += PenaltyN1; }
                    else if (runLen > 5) { result++; parts[0]++; }
                }
                { var pt = FinderPenaltyTerminateAndCount(runColor, runLen, history, size) * PenaltyN3; result += pt; parts[2] += pt; }
            }
            for (var x = 0; x < size; x++)
            {
                var runColor = false;
                var runLen = 0;
                var history = new int[7];
                for (var y = 0; y < size; y++)
                {
                    if (modules[y, x] == runColor) runLen++;
                    else
                    {
                        FinderPenaltyAddHistory(runLen, history, size);
                        if (!runColor) { var p3 = FinderPenaltyCountPatterns(history) * PenaltyN3; result += p3; parts[2] += p3; }
                        runColor = modules[y, x];
                        runLen = 1;
                    }
                    if (runLen == 5) { result += PenaltyN1; parts[0] += PenaltyN1; }
                    else if (runLen > 5) { result++; parts[0]++; }
                }
                { var pt = FinderPenaltyTerminateAndCount(runColor, runLen, history, size) * PenaltyN3; result += pt; parts[2] += pt; }
            }

            // Rule 2: every 2x2 block of one colour.
            for (var y = 0; y < size - 1; y++)
                for (var x = 0; x < size - 1; x++)
                {
                    var c = modules[y, x];
                    if (c == modules[y, x + 1] && c == modules[y + 1, x] && c == modules[y + 1, x + 1])
                        { result += PenaltyN2; parts[1] += PenaltyN2; }
                }

            // Rule 4: deviation of the dark-module ratio from 50%, in 5% steps.
            var dark = 0;
            for (var y = 0; y < size; y++)
                for (var x = 0; x < size; x++)
                    if (modules[y, x]) dark++;
            var totalModules = size * size;
            var k = (Math.Abs(dark * 20 - totalModules * 10) + totalModules - 1) / totalModules - 1;
            result += k * PenaltyN4; parts[3] += k * PenaltyN4;
            return result;
        }

        private static void FinderPenaltyAddHistory(int currentRunLength, int[] history, int size)
        {
            // The first run of a line is preceded by an implicit light margin, which is what makes an edge
            // finder-like pattern score the same as one in the middle.
            if (history[0] == 0) currentRunLength += size;
            Array.Copy(history, 0, history, 1, history.Length - 1);
            history[0] = currentRunLength;
        }

        private static int FinderPenaltyCountPatterns(int[] history)
        {
            var n = history[1];
            var core = n > 0 && history[2] == n && history[3] == n * 3 && history[4] == n && history[5] == n;
            return (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0)
                 + (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0);
        }

        private static int FinderPenaltyTerminateAndCount(bool currentRunColor, int currentRunLength, int[] history, int size)
        {
            if (currentRunColor)
            {
                FinderPenaltyAddHistory(currentRunLength, history, size);
                currentRunLength = 0;
            }
            currentRunLength += size;   // add the implicit light margin at the end of the line
            FinderPenaltyAddHistory(currentRunLength, history, size);
            return FinderPenaltyCountPatterns(history);
        }
    }
}
