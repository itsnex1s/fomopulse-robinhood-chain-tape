/**
 * Preloaded before any test module, because the database path is read once, when the
 * connection module is first imported, and by then it is too late for a test file to
 * set it: a static import anywhere in the run reaches ./db before the first line of
 * the file that meant to point it at memory, and the whole suite ends up sharing the
 * real fomopulse.db — with the last run's rows still in it.
 */
process.env.FOMOPULSE_DB = ":memory:";
