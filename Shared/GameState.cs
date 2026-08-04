namespace VG.Game
{
    // Is a playthrough loaded? The one owner of that question, because several mods gate on it and a second
    // copy is a second chance to write it differently.
    internal static class GameState
    {
        // `GamePlayer.current` is null at the main menu and through a load until the player exists. Anything
        // keyed on the save — a gameplay setting, an automation action — has nothing to act on until then.
        internal static bool Loaded => Source.Player.GamePlayer.current != null;
    }
}
