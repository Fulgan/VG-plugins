using System.Collections.Generic;
using UnityEngine;
using VG.Text;

namespace CicWatch
{
    // WHAT THE HEADER SAYS, in the voice of the section that would be saying it. The panel is a CIC watch officer
    // reporting to the captain, so it holds contacts rather than displaying records: bogeys, friendlies, point
    // sources, a clear plot, a wedge down.
    //
    // NEITHER FORM OF ADDRESS ASSUMES A GENDER. `Skipper` and `Captain` are the only two used, because the game never
    // states what the player character is.
    //
    // Nothing here explains the FILTER. An empty board once printed "none match your rules", which tells the player
    // what they already set and cannot act on; a watch officer with nothing worth passing along simply says so.
    internal static class Voice
    {
        /// <summary>
        /// WHAT THE PLOT HOLDS, counted as the standing report counts it (V21: the header is the AREA, and
        /// <see cref="Designated"/> is the ROW count). Gathered in ONE place (`Watch.Standing`) because two surfaces
        /// speak from it now — the header and the wave call — and a wave that disagreed with the header underneath it
        /// would be worse than either alone.
        /// </summary>
        internal struct Standing
        {
            internal int Hostiles, Friendlies, Boardable, Boarding, Designated;
            internal int Contacts { get { return Hostiles + Friendlies; } }
        }

        private static readonly string[] Clear =
        {
            "Plot's clear, Skipper",
            "Clean boards, Captain",
            "Nothing on the gravitics",
            "Boards are clear, Skipper",
            "No point sources, Captain",
            "Sensors are quiet, Skipper",
            "Not a footprint anywhere",
            "Nothing but stars out here, Captain",
            "Plot's empty, Skipper",
            "Gravitics are cold",
            "Nobody home, Captain",
        };

        // A TAIL, not a report of its own. Hulls in the area are always CALLED, whether or not the quality rules
        // gave any of them a row: a watch officer who saw four bogeys and said "nothing here" would be relieved.
        // So the count leads and this only says none of it earned a line.
        // TRAFFIC, and only when nothing out there is hostile. `merchant traffic only` said of five bogeys is simply
        // wrong: what makes a hostile hull unworthy of a row is its quality, never its trade.
        private static readonly string[] TrafficOne =
        {
            ", merchant traffic",
            ", a freighter, nothing more",
            ", just traffic",
            ", civilian",
            ", nothing military about her",
        };

        private static readonly string[] TrafficMany =
        {
            ", merchant traffic only",
            ", freighters, nothing more",
            ", just traffic",
            ", all civilian",
            ", nothing military out there",
        };

        // INDEX-ALIGNED, singular and plural, like the prize tails: `one bogey, none worth a second look` counts one
        // hull as a group. One contact is `not worth` it; several are `none worth` it.
        private static readonly string[] NotWorthOne =
        {
            ", not worth designating",
            ", not worth your time",
            ", not what we would call a target",
            ", not worth a second look",
            ", below our threshold",
            ", hardly worth calling",
            ", not worth the plot space",
            ", nothing we would break formation for",
        };

        private static readonly string[] NotWorthMany =
        {
            ", nothing worth designating",
            ", none worth your time",
            ", nothing we would call a target",
            ", none worth a second look",
            ", all below our threshold",
            ", hardly worth calling",
            ", none worth the plot space",
            ", nothing we would break formation for",
        };

        // `{0}` is the composition, and NOTHING follows it inside the frame. A frame that carried its own address put
        // the tail after it and produced `CIC has 1 bogey, Captain, none worth a second look`: two comma clauses
        // fighting over one sentence. No frame names the section either, since the header already says `CIC`.
        private static readonly string[] Frames =
        {
            "holding {0}",
            "designating {0}",
            "{0} on the plot",
            "we hold {0}",
            "plot shows {0}",
            "tracking {0}",
            "gravitics show {0}",
            "{0} on our boards",
            "{0} in the volume",
            "sensors hold {0}",
            "reading {0}",
            "{0} inside sensor range",
        };

        // The same frames MINUS the one that claims a designation, for a report whose tail is about to say nothing was
        // designated: `designating 4 bogeys, nothing worth designating` contradicts itself in one breath.
        // DERIVED, not a second list: whatever leads with a claim of designation is dropped, so a frame added above is
        // covered here without being written twice.
        private static readonly string[] PlainFrames = Without(Frames, "designating");

        private static string[] Without(string[] pool, string word)
        {
            var keep = new List<string>(pool.Length);
            foreach (var s in pool)
                if (s.IndexOf(word, System.StringComparison.OrdinalIgnoreCase) < 0) keep.Add(s);
            return keep.ToArray();
        }

        // WHO IS BEING TOLD, appended LAST and after any tail, which is the only position that stays grammatical. The
        // two empty entries are deliberate: a watch officer does not say the captain's title in every second sentence.
        private static readonly string[] Address = { "", "", ", Skipper", ", Captain" };

        /// <summary>A report is a sentence: `one bogey on the plot` starts it, so the first letter is lifted.</summary>
        private static string Sentence(string line)
        {
            return string.IsNullOrEmpty(line) ? line : char.ToUpperInvariant(line[0]) + line.Substring(1);
        }

        // The two tails are INDEX-ALIGNED: one pick chooses the phrasing and the count chooses the form, so a plural
        // never reads as a mangled singular.
        private static readonly string[] PrizeOne =
        {
            ", one wedge down",
            ", one open for a prize crew",
            ", one ripe for a boarding party",
            ", one ready for the pinnaces",
            ", one there for the taking",
            ", one we could put a crew aboard",
        };

        // ONE CONTACT AND IT IS THE PRIZE: `one bogey on the plot, one ripe for a boarding party` counts the same hull
        // twice. With a single contact the tail describes IT, so the number goes.
        private static readonly string[] PrizeSolo =
        {
            ", wedge down",
            ", open for a prize crew",
            ", ripe for a boarding party",
            ", ready for the pinnaces",
            ", there for the taking",
            ", we could put a crew aboard her",
        };

        // A BOARDING IN PROGRESS, which is not an opportunity: the prize tails offer a hull to take, these report
        // people already aboard one. Solo, singular and plural, index-aligned like every other tail here.
        private static readonly string[] BoardingSolo =
        {
            ", boarders away",
            ", prize crew aboard her",
            ", boarding under way",
            ", our people are aboard",
        };

        private static readonly string[] BoardingOne =
        {
            ", boarders away on one",
            ", prize crew aboard one",
            ", one boarding under way",
            ", our people aboard one",
        };

        private static readonly string[] BoardingMany =
        {
            ", boarders away on {0}",
            ", prize crews aboard {0}",
            ", {0} boardings under way",
            ", our people aboard {0}",
        };

        private static readonly string[] PrizeMany =
        {
            ", {0} wedges down",
            ", {0} open for prize crews",
            ", {0} ripe for boarding",
            ", {0} ready for the pinnaces",
            ", {0} there for the taking",
            ", {0} we could put crews aboard",
        };

        // THE SAME TAILS MINUS THE ONE THAT SPENDS THE WORD `down`, for a sentence that has already used it on a hull
        // that was destroyed. `one bogey down; now plot shows two bogeys, one wedge down` says it twice about two
        // different things, and the second reads as another casualty rather than as a hull worth boarding: the word
        // has to belong to one fact per sentence. A prize is still reported, in the words that only ever mean a prize.
        // DERIVED, not three more lists, so a tail added above is covered without being written twice, and the three
        // stay INDEX-ALIGNED because the dropped entry is the same one in each.
        private static readonly string[] PrizeOneKeen = Without(PrizeOne, "down");
        private static readonly string[] PrizeSoloKeen = Without(PrizeSolo, "down");
        private static readonly string[] PrizeManyKeen = Without(PrizeMany, "down");

        // AN ARRIVAL, called once for the whole footprint. `{0}` is what came in.
        // SHORT ENOUGH FOR ONE LINE. The header is 444 px wide and these borrow it whole, so the address is appended
        // from `Address` like everywhere else rather than written into the middle of the frame.
        private static readonly string[] Footprints =
        {
            "New contacts! {0} translated in",
            "Hyper footprint: {0}",
            "New footprint! {0} on the plot",
            "{0} just jumped in",
            "Contacts translating in: {0}",
            "Translation! {0} in the volume",
            "Gravitics just lit up: {0}",
            "{0} came across the wall",
            "New footprint! {0} standing in",
            "Contacts! {0} where there was nothing",
        };

        // HELD UNTIL THE SITUATION CHANGES. The panel redraws at 4 Hz, so rolling a line per redraw would cycle five
        // phrasings a second and read as a fault. A pick therefore lives as long as its SIGNATURE (which of the three
        // reports this is, and what shape the composition has) and is rerolled only when that changes, never onto the
        // line it is replacing.
        // A pick lives exactly as long as its SIGNATURE, and nothing else moves it. Two failures bracket this: holding
        // on the composition SHAPE alone left one sentence up for a whole quiet system, and a timed reroll rewrote the
        // line while nothing out there had changed, which reads as news that is not news. So the signature carries the
        // CONTENT — every count in the report — and the wording changes when, and only when, there is something
        // different to say.
        private static readonly Dictionary<string, string> _sig = new Dictionary<string, string>();
        private static readonly Dictionary<string, int> _held = new Dictionary<string, int>();

        private static int PickIndex(string id, string sig, int count)
        {
            if (count <= 0) return 0;

            int held;
            var have = _held.TryGetValue(id, out held);

            string was;
            if (have && _sig.TryGetValue(id, out was) && was == sig) return held % count;

            var next = Random.Range(0, count);
            if (count > 1 && have && next == held % count) next = (next + 1) % count;
            _sig[id] = sig;
            _held[id] = next;
            return next;
        }

        // THE ONE LINE ALLOWED TO WANDER. Everything else is keyed to content ∴ it changes only when the report does,
        // which is the whole point. An EMPTY plot has no content to key to, and a watch officer standing a quiet
        // watch does not repeat one sentence for an hour, so this one rotates slowly on its own.
        private const float QuietFor = 45f;

        /// <summary>Nothing in the area at all.</summary>
        internal static string EmptyArea()
        {
            // Keyed to the 45 s SLOT rather than to a stored stamp: the signature must be the same string on every
            // redraw inside one window, or the pick would reroll at 4 Hz.
            var slot = ((int)(Time.unscaledTime / QuietFor)).ToString();
            return Clear[PickIndex("clear", slot, Clear.Length)];
        }

        /// <summary>
        /// A WAVE, called once. Rolled fresh every time rather than held: an arrival is an event, and two waves in a
        /// row phrased identically read as one stuck message.
        /// </summary>
        // WHAT CHANGED ON THE PLOT, in one sentence covering both directions. A fight kills and draws at the same
        // time, and reporting the two separately means two calls a second apart contradicting each other in tone.
        //
        // DOWN AND OUT OF RANGE ARE DIFFERENT FACTS and get different words: one is a kill somebody made, the other
        // is a contact that left. Neither claims WHO — the plot cannot tell whose shot it was, and a watch officer
        // reporting a kill as yours when it was a neighbour's would be the one lie this readout could tell.
        private static readonly string[] LossDown =
        {
            "{0} down", "{0} splashed", "{0} off the board", "{0} destroyed",
        };
        private static readonly string[] LossGone =
        {
            "{0} broke contact", "{0} out of range", "{0} off the scope",
        };

        // A HULL THAT TURNED ON US. Not an arrival and not a loss: the same contact, on the other side, which is the
        // one change on this plot that alters what a hull WILL DO without altering what is on the boards. Index-free
        // singular|plural like every other pair here, and it never guesses at a reason — a watch officer reports the
        // hostility, ⊥ the politics behind it.
        private static readonly string[] TurnedOne =
        {
            "{0} just turned on us", "{0} has gone hostile", "{0} is showing hostile", "{0} switched her colours",
        };

        private static readonly string[] TurnedMany =
        {
            "{0} just turned on us", "{0} have gone hostile", "{0} are showing hostile", "{0} switched their colours",
        };

        // WHAT CHANGED, THEN WHAT WE HOLD, in one sentence. The call borrows the header line, so a call that named
        // only the change left the standing report unreadable for as long as it was up: the two are one message.
        // The change leads, because it is the new fact; the standing half follows behind a semicolon, in the same
        // words the header itself would use, so the line the flash replaces reads as a continuation of it.
        /// <summary>
        /// WHAT WAS LOST, and it is two facts per hull rather than one: which way it went, and whose it was. One
        /// pair of counters answered both, so a friendly flying away was announced as `one bogey down` — the side
        /// was never carried, and the way was inferred from a destroyed reference (`Watch` now looks the fate up by
        /// guid instead).
        /// </summary>
        internal struct Losses
        {
            internal int DownHostile, DownFriendly, GoneHostile, GoneFriendly;
            internal int Down { get { return DownHostile + DownFriendly; } }
            internal int Gone { get { return GoneHostile + GoneFriendly; } }
            internal int Any { get { return Down + Gone; } }
        }

        /// <summary>
        /// THE NOUN A LOSS TAKES. `bogeys` for hostiles, `friendlies` for ours, and `contacts` where a batch holds
        /// both — because naming a mixed loss after either side would be wrong about the other half, and a watch
        /// officer would say the neutral word rather than pick.
        /// </summary>
        private static string LostAs(int hostile, int friendly)
        {
            if (hostile > 0 && friendly > 0) return Say.Spoken(hostile + friendly, "contact", "contacts");
            if (hostile > 0) return Say.Spoken(hostile, "bogey", "bogeys");
            return Say.Spoken(friendly, "friendly", "friendlies");
        }

        internal static string Change(int hostiles, int friendlies, int prizes, Losses lost, int turned,
                                      Standing now)
        {
            var arriving = hostiles + friendlies;
            // A loss that went DOWN is the only one that spends the word; a contact that merely left says `broke
            // contact` and leaves the prize tails their whole vocabulary.
            var standing = NowHolding(now, arriving, lost.Down > 0);
            var told = standing.Length > 0;

            // WHATEVER THE STANDING HALF COUNTS IS NOT SAID TWICE. It reports every boardable hull in the area, the
            // new ones included, so the change half drops its prize clause whenever that half is coming.
            //
            // A TURN TAKES THE SENTENCE OVER. The arrival frames are about a FOOTPRINT — something crossing the wall
            // — and a hull that was already on the plot crossed nothing, so a frame saying it did would be wrong even
            // where the wave also holds arrivals. The composed clause states each fact in turn instead, and the turn
            // leads it: of everything in one call, it is the one that changes what a contact will DO.
            var change = lost.Any + turned <= 0
                // Nothing lost and nobody turned ∴ this IS an arrival, and the arrival voice is better at saying so
                // than a composed sentence with an empty half would be.
                ? ArrivalClause(hostiles, friendlies, told ? 0 : prizes)
                : LossClause(arriving, prizes, lost, turned, told);

            // ONE ADDRESS, AT THE END OF THE WHOLE SENTENCE, which is the only position that stays grammatical. A
            // clear plot brings its own (`Plot's clear, Skipper`) ∴ appending one there would name the captain twice.
            if (!told) return Sentence(change + Address[Roll("address", Address.Length)]);
            var tail = now.Contacts == 0 ? "" : Address[Roll("address", Address.Length)];
            return Sentence(change + "; " + standing + tail);
        }

        private static string LossClause(int arriving, int prizes, Losses lost, int turned, bool told)
        {
            var parts = new List<string>();
            // FIRST, and it is the only clause here that reports a hull neither arriving nor leaving. `Spoken` picks
            // the form; the two pools are index-free because the verb changes with the number in both of them.
            if (turned > 0)
                parts.Add(string.Format(turned > 1 ? TurnedMany[Roll("turned", TurnedMany.Length)]
                                                   : TurnedOne[Roll("turned", TurnedOne.Length)],
                                        Say.Spoken(turned, "friendly", "friendlies")));
            // WHOSE, in the noun: `two bogeys splashed` and `one friendly broke contact` are different reports, and
            // the same sentence said both until the side travelled with the count.
            if (lost.Down > 0)
                parts.Add(string.Format(LossDown[Roll("lossdown", LossDown.Length)],
                                        LostAs(lost.DownHostile, lost.DownFriendly)));
            if (lost.Gone > 0)
                parts.Add(string.Format(LossGone[Roll("lossgone", LossGone.Length)],
                                        LostAs(lost.GoneHostile, lost.GoneFriendly)));

            // The INBOUND half rides on the same sentence rather than in a frame of its own: "three bogeys down,
            // four more inbound" is one report, where two frames would be two.
            // `Spoken` already spells the number and picks the form, so the phrase is passed whole and BOTH forms
            // are given: "more inbound" does not inflect, and letting the pluraliser guess would give "more
            // inbounds".
            if (arriving > 0) parts.Add(Say.Spoken(arriving, "more inbound", "more inbound"));
            if (prizes > 0 && !told) parts.Add(Say.Spoken(prizes, "ripe for boarding", "ripe for boarding"));

            return string.Join(", ", parts.ToArray());
        }

        // THE SECOND HALF: the standing report, prefixed with `now` so it reads as the state the change left behind.
        // Empty where it would only repeat the first half — a wave into an empty area has already said what is out
        // there, and `four new bogeys translated in, now holding four bogeys` is one report given twice. Two states
        // survive that test because the change half cannot state either: an EMPTY plot (`three bogeys splashed,
        // plot's clear` is the end of the engagement) and a boarding already under way.
        private static string NowHolding(Standing now, int arriving, bool downSaid)
        {
            if (now.Contacts == 0) return arriving > 0 ? "" : Lower(EmptyArea());
            if (now.Contacts == arriving && now.Boarding <= 0) return "";

            string sig;
            return "now " + Clause(now, out sig, downSaid);
        }

        /// <summary>A clear-plot line mid-sentence: it is written as an opener, so its first letter comes down.</summary>
        private static string Lower(string line)
        {
            return string.IsNullOrEmpty(line) ? line : char.ToLowerInvariant(line[0]) + line.Substring(1);
        }

        internal static string Arrival(int hostiles, int friendlies, int prizes)
        {
            return Sentence(ArrivalClause(hostiles, friendlies, prizes) + Address[Roll("address", Address.Length)]);
        }

        private static string ArrivalClause(int hostiles, int friendlies, int prizes)
        {
            var bogeys = Say.Spoken(hostiles, "new bogey", "new bogeys");
            var friends = Say.Spoken(friendlies, "friendly", "friendlies");

            var what = hostiles > 0 && friendlies > 0 ? bogeys + " and " + friends
                     : hostiles > 0 ? bogeys
                     : friendlies > 0 ? friends
                     : Say.Spoken(hostiles + friendlies, "new point source", "new point sources");

            var line = string.Format(Footprints[Roll("footprint", Footprints.Length)], what);

            if (prizes > 0)
            {
                var i = Roll("prize", PrizeOne.Length);
                line += prizes > 1 ? string.Format(PrizeMany[i % PrizeMany.Length], prizes.ToString())
                      : hostiles + friendlies == 1 ? PrizeSolo[i % PrizeSolo.Length]
                      : PrizeOne[i];
            }

            return line;
        }

        /// <summary>A pick with no signature: a fresh line each call, never the one it just used.</summary>
        private static int Roll(string id, int count)
        {
            if (count <= 0) return 0;

            int held;
            var have = _held.TryGetValue(id, out held);
            var next = Random.Range(0, count);
            if (count > 1 && have && next == held % count) next = (next + 1) % count;
            _held[id] = next;
            _sig.Remove(id);
            return next;
        }

        /// <summary>
        /// The standing report: what we hold, whether any of it can be taken, and whether any of it earned a row.
        /// <paramref name="designated"/> is how many hulls the quality rules kept, which is the ROW count and never
        /// what is out there.
        /// </summary>
        internal static string Report(Standing s)
        {
            if (s.Contacts == 0) return EmptyArea();

            string sig;
            // The standing report stands alone: nothing before it has said anything went down.
            var line = Clause(s, out sig, false);
            return Sentence(line + Address[PickIndex("address", sig, Address.Length)]);
        }

        // THE REPORT WITHOUT ITS ADDRESS, so a wave call can carry it as the second half of its own sentence and
        // still name the captain once, at the end. The signature comes back with it because the address pick is keyed
        // to the same content as every other pick in the line.
        // `downSaid`: the half of the sentence already written reports a hull DESTROYED, so this half may not reuse
        // that word for a hull that can be taken.
        private static string Clause(Standing s, out string sigOut, bool downSaid)
        {
            var hostiles = s.Hostiles;
            var friendlies = s.Friendlies;
            var boardable = s.Boardable;
            var boarding = s.Boarding;
            var designated = s.Designated;

            var bogeys = Say.Spoken(hostiles, "bogey", "bogeys");
            var friends = Say.Spoken(friendlies, "friendly", "friendlies");

            var what = hostiles > 0 && friendlies > 0 ? bogeys + " and " + friends
                     : hostiles > 0 ? bogeys
                     : friendlies > 0 ? friends
                     // Hostility unread rather than absent: a contact we hold but cannot classify is still a point
                     // source, which is exactly what the sensor gives us.
                     : Say.Spoken(hostiles + friendlies, "point source", "point sources");

            // WHAT IS BEING REPORTED, counts and all: a hull destroyed or another one arriving IS something different
            // to say, and a plot that has not moved gets the sentence it already had.
            var sig = hostiles + "/" + friendlies + "/" + boardable + "/" + boarding + "/" + (designated > 0 ? 1 : 0);
            sigOut = sig;
            var frames = designated > 0 || boardable > 0 || boarding > 0 ? Frames : PlainFrames;
            var line = string.Format(frames[PickIndex("contacts", sig, frames.Length)], what);

            var solo = hostiles + friendlies == 1;

            if (boardable > 0)
            {
                // The pools that never say `down` where the first half of the sentence already did.
                var one = downSaid ? PrizeOneKeen : PrizeOne;
                var lone = downSaid ? PrizeSoloKeen : PrizeSolo;
                var many = downSaid ? PrizeManyKeen : PrizeMany;
                var i = PickIndex("prize", sig, one.Length);
                line += boardable > 1 ? string.Format(many[i % many.Length], boardable.ToString())
                      : solo ? lone[i % lone.Length]
                      : one[i];
            }

            // BOTH CAN BE TRUE: one hull open to a boarding party while a boarding already runs against another. The
            // offer comes first and the action second, which is the order a watch officer would give them in.
            if (boarding > 0)
            {
                var i = PickIndex("boarding", sig, BoardingOne.Length);
                line += boarding > 1 ? string.Format(BoardingMany[i % BoardingMany.Length], boarding.ToString())
                      : solo ? BoardingSolo[i % BoardingSolo.Length]
                      : BoardingOne[i];
            }

            if (boardable <= 0 && boarding <= 0 && designated <= 0)
            {
                // Nothing kept a row AND nothing can be taken: say the count, then say it is all beneath notice. A
                // prize in the area is never called beneath notice, whatever the rules say about the rest.
                // Nothing hostile out there ⇒ the reason is what they ARE; otherwise it is what they are worth.
                var one = hostiles > 0 ? NotWorthOne : TrafficOne;
                var many = hostiles > 0 ? NotWorthMany : TrafficMany;
                var i = PickIndex("filtered", sig, one.Length);
                line += solo ? one[i] : many[i % many.Length];
            }

            return line;
        }
    }
}
