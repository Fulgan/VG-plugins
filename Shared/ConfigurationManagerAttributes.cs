namespace VG.Shared
{
    // Duck-typed by the BepInEx ConfigurationManager plugin. In `Shared/` and compiled into BOTH mods rather than
    // copied into each: it is matched by class + field NAMES, so one definition serves any namespace, and two
    // copies would be two things to keep in step for no gain.
    // Duck-typed by the BepInEx ConfigurationManager plugin (matched by class + field names via
    // reflection, namespace-agnostic). Browsable=false hides the config entry from the in-game UI, so a
    // developer flag stays out of the public plugin's settings while still living in the .cfg file.
    internal sealed class ConfigurationManagerAttributes
    {
        public bool? Browsable;
        public bool? IsAdvanced;
    }
}
