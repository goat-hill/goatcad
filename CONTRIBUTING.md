# Contributing to GoatCAD

GoatCAD is written almost entirely by AI agents: Claude Code, running Claude Fable 5 and Claude
Opus 5, 5.1 and 5.5. The maintainers decide what gets built, steer the agents, and review what they
produce. The most useful thing you can bring is judgment: what is broken, what is missing, and what
would make the app better to use.

## How to help

- **Open an issue** at [github.com/goat-hill/goatcad/issues](https://github.com/goat-hill/goatcad/issues),
  or use **Help ▸ Share App Feedback…** in the app, which fills in your version and system for you.
  Bugs, rough edges, missing features and KiCad incompatibilities are all welcome. The maintainers
  read every report and use them to direct the agents' next features and fixes.
- **Translations are especially welcome.** A fluent speaker catches what a machine pass gets wrong.
  Strings live in `electron/src/renderer/src/locales/<language>/`; corrections to an existing
  language and new languages are both welcome.

We are not looking for code pull requests. A fix you have in mind is most useful as an issue that
describes the problem and, if you like, the approach; the maintainers will hand it to an agent.
Besides translations, we are open to a few things being done by hand rather than by an agent:
user-facing copy, and design or brand work (icons, layout, visual polish), guided by
[docs/BRAND.md](docs/BRAND.md) and [docs/DESIGN.md](docs/DESIGN.md).

## Becoming a maintainer

We may add maintainers over time: people whose taste in features we trust, and who can judge the
technical approaches agents propose and tell a sound one from a plausible one.

## License of contributions

Contributions are accepted under GoatCAD's license, the GNU General Public License, version 3 or
later ([LICENSE](LICENSE)). By opening a pull request you agree your contribution is licensed that
way; there is no separate agreement to sign, and you keep the copyright in what you write.

## Material from elsewhere

Anything you bring from another source (a translation memory, an icon set, a font) must be under a
GPL-3.0-compatible license, and you must say where it came from in the pull request.
