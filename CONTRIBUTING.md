# Jak přispět / Contributing

Díky, že chceš pomoct! / Thanks for helping!

## Nápad nebo chyba

Založ [issue](https://github.com/K3iVi/claude-okna/issues/new/choose) — šablona „Nápad“ nebo „Chyba“.
U chyby pomůže verze Claude Code (`claude --version`), verze pluginu a co přesně panel ukázal.
**Do issue nevkládej svůj klíč z `okna.json` ani soukromé názvy oken.**

## Úprava kódu

1. Fork → větev → změna → pull request.
2. Kód pluginu je v `hooks/register.tsx`, typy stavu v `types/index.d.ts`, testy v `tests/`.
3. Před PR spusť:

   ```bash
   claude plugin validate .
   ```

   ```bash
   claude plugin test .
   ```

4. Vyzkoušej lokálně: `claude --plugin-dir <cesta k repu>` nebo v aplikaci přidej složku jako
   marketplace (`claude plugin marketplace add <cesta>`), pak `/reload-plugins`.
5. Texty v UI jsou česky, kód a komentáře anglicky. Překlady UI jsou vítané.

Vzorový server (`server/okna_server.py`) drž jen na standardní knihovně Pythonu.

---

Open an issue for ideas or bugs (never paste your sync key). For code: fork, branch, run
`claude plugin validate .` and `claude plugin test .`, open a PR. UI strings are Czech, code is English.
