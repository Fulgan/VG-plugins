using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace Hypercom
{
    // Minimal JSON codec — no NuGet (plugin references game DLLs only).
    // Writer serializes an object graph: IDictionary<string,object>, IEnumerable, string, bool,
    // integral/floating numbers, null. Parser returns Dictionary<string,object> / List<object> /
    // string / double / bool / null. Enough for flat request bodies and nested responses.
    internal static class Json
    {
        // ---- writer ----

        internal static string Write(object value)
        {
            var sb = new StringBuilder(256);
            WriteValue(sb, value);
            return sb.ToString();
        }

        private static void WriteValue(StringBuilder sb, object v)
        {
            switch (v)
            {
                case null:
                    sb.Append("null");
                    break;
                case string s:
                    WriteString(sb, s);
                    break;
                case bool b:
                    sb.Append(b ? "true" : "false");
                    break;
                case float f:
                    sb.Append(f.ToString("R", CultureInfo.InvariantCulture));
                    break;
                case double d:
                    sb.Append(d.ToString("R", CultureInfo.InvariantCulture));
                    break;
                case IDictionary<string, object> map:
                    WriteObject(sb, map);
                    break;
                case IEnumerable e when !(v is string):
                    WriteArray(sb, e);
                    break;
                default:
                    // integral types (int, long, short, byte, enum-as-number) and anything IConvertible.
                    if (v is sbyte || v is byte || v is short || v is ushort || v is int
                        || v is uint || v is long || v is ulong)
                        sb.Append(Convert.ToString(v, CultureInfo.InvariantCulture));
                    else
                        WriteString(sb, Convert.ToString(v, CultureInfo.InvariantCulture));
                    break;
            }
        }

        private static void WriteObject(StringBuilder sb, IDictionary<string, object> map)
        {
            sb.Append('{');
            var first = true;
            foreach (var kv in map)
            {
                if (!first) sb.Append(',');
                first = false;
                WriteString(sb, kv.Key);
                sb.Append(':');
                WriteValue(sb, kv.Value);
            }
            sb.Append('}');
        }

        private static void WriteArray(StringBuilder sb, IEnumerable items)
        {
            sb.Append('[');
            var first = true;
            foreach (var item in items)
            {
                if (!first) sb.Append(',');
                first = false;
                WriteValue(sb, item);
            }
            sb.Append(']');
        }

        private static void WriteString(StringBuilder sb, string s)
        {
            sb.Append('"');
            foreach (var c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < ' ')
                            sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        else
                            sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
        }

        // ---- parser ----

        // Returns null on empty input. Throws FormatException on malformed JSON.
        internal static object Parse(string text)
        {
            if (string.IsNullOrWhiteSpace(text))
                return null;
            var p = new Parser(text);
            var v = p.ParseValue();
            p.SkipWhitespace();
            if (!p.AtEnd)
                throw new FormatException("trailing content after JSON value");
            return v;
        }

        // Convenience: parse into a string-keyed map, or empty map if body isn't an object.
        internal static Dictionary<string, object> ParseObject(string text)
            => Parse(text) as Dictionary<string, object> ?? new Dictionary<string, object>();

        private sealed class Parser
        {
            private readonly string _s;
            private int _i;

            internal Parser(string s) { _s = s; _i = 0; }

            internal bool AtEnd => _i >= _s.Length;

            internal void SkipWhitespace()
            {
                while (_i < _s.Length && char.IsWhiteSpace(_s[_i])) _i++;
            }

            internal object ParseValue()
            {
                SkipWhitespace();
                if (AtEnd) throw new FormatException("unexpected end of JSON");
                var c = _s[_i];
                switch (c)
                {
                    case '{': return ParseObj();
                    case '[': return ParseArr();
                    case '"': return ParseStr();
                    case 't': Literal("true"); return true;
                    case 'f': Literal("false"); return false;
                    case 'n': Literal("null"); return null;
                    default: return ParseNumber();
                }
            }

            private Dictionary<string, object> ParseObj()
            {
                var map = new Dictionary<string, object>();
                _i++; // {
                SkipWhitespace();
                if (!AtEnd && _s[_i] == '}') { _i++; return map; }
                while (true)
                {
                    SkipWhitespace();
                    if (AtEnd || _s[_i] != '"') throw new FormatException("expected object key");
                    var key = ParseStr();
                    SkipWhitespace();
                    if (AtEnd || _s[_i] != ':') throw new FormatException("expected ':'");
                    _i++;
                    map[key] = ParseValue();
                    SkipWhitespace();
                    if (AtEnd) throw new FormatException("unterminated object");
                    if (_s[_i] == ',') { _i++; continue; }
                    if (_s[_i] == '}') { _i++; break; }
                    throw new FormatException("expected ',' or '}'");
                }
                return map;
            }

            private List<object> ParseArr()
            {
                var list = new List<object>();
                _i++; // [
                SkipWhitespace();
                if (!AtEnd && _s[_i] == ']') { _i++; return list; }
                while (true)
                {
                    list.Add(ParseValue());
                    SkipWhitespace();
                    if (AtEnd) throw new FormatException("unterminated array");
                    if (_s[_i] == ',') { _i++; continue; }
                    if (_s[_i] == ']') { _i++; break; }
                    throw new FormatException("expected ',' or ']'");
                }
                return list;
            }

            private string ParseStr()
            {
                var sb = new StringBuilder();
                _i++; // opening "
                while (_i < _s.Length)
                {
                    var c = _s[_i++];
                    if (c == '"') return sb.ToString();
                    if (c == '\\')
                    {
                        if (_i >= _s.Length) break;
                        var e = _s[_i++];
                        switch (e)
                        {
                            case '"': sb.Append('"'); break;
                            case '\\': sb.Append('\\'); break;
                            case '/': sb.Append('/'); break;
                            case 'b': sb.Append('\b'); break;
                            case 'f': sb.Append('\f'); break;
                            case 'n': sb.Append('\n'); break;
                            case 'r': sb.Append('\r'); break;
                            case 't': sb.Append('\t'); break;
                            case 'u':
                                if (_i + 4 > _s.Length) throw new FormatException("bad \\u escape");
                                sb.Append((char)int.Parse(_s.Substring(_i, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                                _i += 4;
                                break;
                            default: throw new FormatException("bad escape \\" + e);
                        }
                    }
                    else sb.Append(c);
                }
                throw new FormatException("unterminated string");
            }

            private double ParseNumber()
            {
                var start = _i;
                while (_i < _s.Length && "+-0123456789.eE".IndexOf(_s[_i]) >= 0) _i++;
                var slice = _s.Substring(start, _i - start);
                if (!double.TryParse(slice, NumberStyles.Float, CultureInfo.InvariantCulture, out var d))
                    throw new FormatException("bad number '" + slice + "'");
                return d;
            }

            private void Literal(string lit)
            {
                if (_i + lit.Length > _s.Length || _s.Substring(_i, lit.Length) != lit)
                    throw new FormatException("expected '" + lit + "'");
                _i += lit.Length;
            }
        }
    }
}
