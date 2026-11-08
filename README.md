# okna — přehled oken Claude Code

Panel do aplikace Claude (záložka Code), který na jednom místě ukazuje všechna rozpracovaná okna:
kde Claude čeká na tvoje rozhodnutí, kde ještě pracuje, kde brzy vyprší cache a co jsi ještě nečetl.
Kliknutím na řádek se okno otevře.

*English summary at the bottom.*

![Panel Okna (ukázková data)](docs/panel.png)

## Proč

Když běží deset a víc oken najednou, snadno se ztratí to jedno, které už půl hodiny čeká na „ano/ne“.
Postranní seznam aplikace řadí okna podle času, ne podle toho, co chtějí od tebe. Panel je řadí podle toho,
co máš udělat:

- **Čeká na tebe** — Claude skončil a ptá se (otázka je vidět přímo pod názvem),
- **Pracuje** — právě běží, nebo mu na pozadí ještě pracují subagenti,
- **Končí cache** — okno bylo naposledy aktivní před 50–60 min; když do něj napíšeš teď,
  pokračuje levně z cache (červeně „za 6 min“),
- **Nepřečtené** — Claude odpověděl a ty jsi okno od té doby neotevřel,
- **› Dřív** — ostatní, sbalené, menším písmem,
- **› Odloženo** — okna, která jsi odložil.

Volitelně barevný proužek nahoře (poměr skupin na první pohled).

## Odložit a skrýt

Na řádku (při najetí myší) jsou dvě akce:

- **odložit** — okno zmizí ze skupin dolů do „Odloženo“, dokud do něj znovu nenapíšeš
  (nebo ho tam nevrátíš tlačítkem **vrátit**). Hodí se na „teď ne, ale nezapomenout“.
- **skrýt** — okno z panelu zmizí úplně, dokud do něj nenapíšeš. Na okna, která vidět nepotřebuješ
  (třeba pravidelné úlohy).

Okna se stejným začátkem názvu jde skrýt trvale v nastavení (`hideTitles`, viz níže).

## Centrála — odpovídání z jednoho okna

Pojmenuj jedno okno **„Centrála“** (a zapni mu Remote Control, chceš-li odpovídat z mobilu). Plugin v něm
pak hlídá ostatní okna, a když se některé zeptá, spustí v Centrále jeden tah: ta ukáže otázku s tlačítky
toho okna (z jeho rámečku „Další krok“ nebo z jeho otázky s volbami) a tvoji volbu pošle do okna doslova.
Ostatní okna dál čekají na tebe, nic se nerozhoduje samo.

- Nic se neprochází dokola: Centrála dělá tah jen při nové otázce (ostatní okna to nestojí nic).
- Stav je v `%USERPROFILE%\.claude\centrala.json` (otázky + co pracuje / je nepřečtené / odložené);
  Centrála ho čte skillem `centrala` (`/okna:centrala` ručně).
- Jiný název okna: `"central": "<regulární výraz>"` v `okna.json`.
- Otevřený dialog v Centrále zmizí, když otázku mezitím vyřešíš přímo v okně (ostatní otázky z něj
  se ukážou znovu). Odpověď do okna, které mezitím pokračovalo, plugin neodešle — ani když se Centrála
  splete. Neodešle ani odpověď, kterou jsi v dialogu u otázky toho okna nevybral ani nenapsal
  (Centrála si ji nesmí domyslet); odpověď, kterou Centrále nadiktuješ sám v novém tahu, projde.
- Příkaz s lomítkem (`/reload-plugins`…) napsaný, když má Centrála otevřený dialog, dojde Centrále
  jako zpráva a spustí se až po jejím tahu.
- Do Centrály jde otázka, jen když přepis okna potvrdí, že po ní nic nepřišlo — samotnému hodnocení
  aplikace (ani jejímu „pracuje / nepracuje“) se nevěří.
- Centrála sama hlídá ostatní okna (podle svých pravidel, ať mají ostatní okna jakoukoli verzi pluginu)
  a frontu přepisuje každých 10 s; starší fronta znamená, že plugin v Centrále neběží.
- Okno s pluginem 0.9+ hlásí svůj stav samo (viz níže): Centrála pak vidí i dialog s volbami, který
  okno otevřelo uprostřed práce, a tvou volbu mu doručí plugin — okno ji dostane jako tvoji odpověď
  (do dialogu jako klik, po skončeném tahu jako tvoji zprávu) a vezme ji, jen když se pořád ptá na totéž.
  Model Centrály v tu chvíli nic neposílá. Dialog s víc otázkami (0.9.1+) ukáže Centrála po
  částech („Název“ (1/2), (2/2)), každou s jejími tlačítky; okno dostane odpovědi až na všechny
  najednou — „Později“ u kterékoli znamená, že čeká dál.
- Když se ptá fork okna (nebo okno, které jiné spustilo) a jeho rodič otázku zopakuje, Centrála
  ukáže jen otázku forku; rodičovu zase, až fork doběhne a na nic nečeká (0.9.3+).
- Otázka se v Centrále ukáže, až 10 s trvá: když odpovíš rovnou v okně, Centrála ji vůbec neukáže.
- Okno, které čeká na schválení nástroje, Centrála jen vypíše; schválit jde jen v okně.
- Zatím jen okna tohoto PC.

## Jak panel pozná, že okno čeká

Od verze 0.9 každé okno zapisuje svůj stav samo z vlastních hooků do
`%USERPROFILE%\.claude\okna-stav\<okno>.json` (jeden soubor na okno, píše ho jen to okno): pracuje,
ptá se (rámeček „Další krok“ s otázkou), dialog s volbami, čeká na schválení, hotovo. Cokoli, co v okně
začne tah (tvoje zpráva, Centrála, oznámení), otázku hned ruší. Soubor platí, jen když ho okno v posledních
2 minutách obnovilo a aplikace od jeho změny neviděla konec dalšího tahu; jinak (starší verze pluginu,
selhaný hook) se pro to okno použije čtení přepisu níže.

Bez platného souboru podle toho, jak skončil poslední tah okna, v tomto pořadí:

1. po poslední odpovědi okna už něco přišlo (tvoje zpráva, i přerušená, zpráva jiného okna, `/clear`
   a psaní dál) → nečeká,
2. tah skončil rámečkem „Další krok“ s otázkou → čeká (otázka i tlačítka jdou do Centrály),
3. hodnocení aplikace (to, podle kterého svítí boční panel) říká „čeká na tebe“ → čeká,
4. aplikace nebo rámeček bez otázky říkají, že nic nečeká → nečeká,
5. jinak odhad podle závěru odpovědi (otazník, „mám to udělat?“…).

Přepis okna se čte z `~/.claude/projects/…/<relace>.jsonl` (jen konec souboru; compact a místní příkazy
jako `/model` tah nezačínají). Platí jen konec, který obsahuje poslední odpověď okna podle aplikace —
jinak panel neví a nic neukáže. Čte se jednou za odpověď a znovu, jen když přepis čekajícího okna
mezitím narostl. Okno, které právě pracuje, nikdy nečeká.

Po aktualizaci pluginu dej `/reload-plugins` ve všech oknech (nebo restartuj aplikaci): okna se starší
verzí počítají stav po svém.

### Noc

V Centrále napiš **„noc“** (nebo „noc do 8:00“): pracujícím a čekajícím oknům přepne oprávnění na *auto*
(každé schválíš) a pošle jim zprávu `[noc]`, ať vratné věci rozhodují samy, zapisují je do
`~/.claude/noc-zaznam.md` a co chce tvoje OK, nechají na ráno. Přes noc se Centrála nebudí;
v nastavený čas (výchozí 7:00) nebo na **„ráno“** vrátí oprávnění, shrne noc a ukáže odložené otázky.

Okna se řídí pravidlem „Režim noc“ ve tvém `CLAUDE.md` — sepiš si do něj, co smí rozhodnout sama
(kód, testy, commity…) a co nikdy (nasazení, zprávy ven, mazání…).

## Orca

V Orce aplikace Claude chybí, takže panel Okna
zůstane zavřený. Plugin v okně ale od 0.9.9 dál hlásí stav okna pod jeho id z Orcy
(`okna-stav/orca-<ORCA_AGENT_SESSION_ID>.json`) a bere odpovědi, které mu tam někdo nechá.

Centrálu v Orce dělá plugin Orcy ve složce [`orca/`](orca/), bez modelu, takže provoz nestojí tokeny:

- panel **Centrála** ukazuje okna (chaty Orcy; agent v terminálu zatím ne), která čekají: dialog s volbami (tlačítka okna), otázku na konci
  odpovědi (pole pro vlastní odpověď) a čekání na schválení nástroje (jen se ukáže);
- stisk tlačítka zapíše odpověď a plugin v okně ji do pár sekund vloží jako tvoji zprávu, nebo zavře
  dialog. Bere ji jen tehdy, když se okno ptá pořád na totéž;
- u názvu okna jsou ikony: tužka otevře pole pro vlastní odpověď, pauza (**Později**) otázku schová, dokud se
  okno nezeptá znovu, šipka (**Otevřít okno**) ukáže jeho workspace;
- pod otázkami je přehled **Okna** se všemi agenty Orcy (i v terminálu): čeká v okně, končí cache (tah skončil
  před 45–60 min), pracuje, hotovo, sbalené dřívější; barevný proužek ukáže poměr skupin. Přehled jde sbalit a panel
  si to pamatuje. Klik na řádek ukáže workspace okna; konkrétní chat Orca pluginům přepnout nedovolí.

Nastavení panelu (Orca → Settings → plugin Centrála): velikost písma (Malé / Normální), přehled oken,
dřívější okna, barevný proužek, kontext u otázek a popisy voleb. Malé je nejmenší písmo, které Orca
pluginům dovolí.

Noc, ráno a Remote Control v Orce zatím nejsou.

### Instalace do Orcy

1. **Plugin Okna do Claude Code** (verze 0.9.9 nebo novější), podle [Instalace](#instalace) níže.
   Chaty Orcy otevřené před instalací načtou plugin až po `/reload-plugins` (nebo v novém chatu).
2. **Stáhni repo** (Orca zatím neumí instalovat plugin z podsložky repa na GitHubu):
   ```
   git clone https://github.com/K3iVi/claude-okna
   ```
3. **Nainstaluj panel do Orcy** ze složky `orca`:
   ```
   orca plugin install claude-okna/orca
   ```
   Orca nejdřív nic nezapíše a vypíše, co plugin dostane: vlastní proces Node.js s přístupem tvého účtu
   (čte `~/.claude/okna-stav` a spouští `orca worktree ps`), vlastní úložiště a otevírání workspace.
   Když souhlasíš, spusť příkaz, který Orca vypíše: totéž s `--approve ap1-…`.
4. **Panel Centrála** je v pravém postranním panelu Orcy (ikona zvonku), nebo `orca plugin open local.centrala`.

Aktualizace: `git -C claude-okna pull` a znovu krok 3 (nová verze má nový otisk pro `--approve`).
Pro úpravy panelu: `orca plugin dev load claude-okna/orca` načítá změny ze složky průběžně, testy
`orca plugin test claude-okna/orca`.

## Víc počítačů

Pracuješ-li na dvou PC, panel umí ukázat i okna druhého počítače — vlastní sekce s názvem PC
(např. „NOTEBOOK“) se stejnými skupinami. Kliknutí otevře okno přes Remote Control
(`claude://claude.ai/code/session_…`), i když běží na druhém PC. Na zdrojovém PC musí mít okno
zapnutý Remote Control.

Propojení jde přes **tvůj vlastní malý server** (viz [Server pro víc PC](#server-pro-víc-pc)).
Bez nastavení panel nic nikam neposílá — funguje jen lokálně.

## Instalace

V Claude Code (terminál nebo aplikace):

```
/plugin install okna --marketplace K3iVi/claude-okna
```

nebo z příkazové řádky:

```bash
claude plugin marketplace add K3iVi/claude-okna
```

```bash
claude plugin install okna@claude-okna
```

Pak `/reload-plugins` (nebo restart). Panel otevřeš příkazem `/okna` — v aplikaci se objeví jako záložka
„Okna“ vedle Souborů a Úkolů.

Aktualizace: `claude plugin marketplace update claude-okna` a `/reload-plugins`.

**Požadavky:** Windows a desktopová aplikace Claude (panel čte záznamy oken, které si aplikace ukládá
v `%LOCALAPPDATA%\Claude-Data`). macOS/Linux zatím ne — pull request vítán.

## Nastavení (nepovinné)

Soubor `%USERPROFILE%\.claude\okna.json`:

```json
{
  "hideTitles": ["^Denní kontrola", "^RC hlídač"],
  "sync": {
    "url": "https://okna.example.com",
    "key": "tvůj-tajný-klíč"
  }
}
```

- `hideTitles` — regulární výrazy (bez ohledu na velikost písmen); okna s takovým názvem se nezobrazí.
- `sync` — server pro víc PC. Adresa musí být `https://`. Bez `sync` se nic neposílá.
  (Starší `okna-sync.json` s `{"url", "key"}` z verze 0.5 se čte dál, když `okna.json` `sync` nemá.)

Po změně souboru `/reload-plugins`. Soubor obsahuje klíč — nedávej ho do gitu ani do sdílené složky.

## Server pro víc PC

Každé PC zhruba co 10 s pošle:

```
POST {url}/{název-PC}
Authorization: Bearer {key}
Content-Type: application/json

{"rows": [{"title": "…", "isRunning": false, "waiting": true, "unread": false,
           "snippet": "otázka…", "lastActivityAt": "2026-11-05T05:00:00Z",
           "rcLink": "claude://claude.ai/code/session_…"}]}
```

a server odpoví stavem ostatních PC se stejným klíčem:

```json
{"pcs": [{"pc": "NOTEBOOK", "at": 1762318800, "rows": [ … ]}]}
```

(`at` = unixový čas v sekundách; PC, které se neozvalo 15 min, server nevrací.)

Hotový vzorový server je v [`server/okna_server.py`](server/okna_server.py) (jen standardní knihovna Pythonu,
stav v paměti). Spustí se:

```bash
OKNA_KEYS=tvuj-klic python server/okna_server.py
```

Poslouchá na `127.0.0.1:8787`; panel mluví jen přes https, takže ho dej za reverzní proxy
(Caddy, nginx) nebo za `tailscale serve`.

### Zadání pro tvoje AI

Chceš-li to nechat udělat svého asistenta, zkopíruj mu tohle:

> Nastav mi synchronizaci pluginu Claude Code „okna“ (https://github.com/K3iVi/claude-okna) mezi mými počítači.
> 1. Na mém serveru (nebo jednom PC v síti Tailscale) spusť `server/okna_server.py` z toho repa jako službu
>    (systemd / Plánovač úloh), s náhodným klíčem v proměnné `OKNA_KEYS` (vygeneruj
>    `python -c "import secrets; print(secrets.token_urlsafe(32))"`), a zpřístupni ho přes HTTPS —
>    reverzní proxy (Caddy) nebo `tailscale serve --https=443 http://127.0.0.1:8787`.
> 2. Ověř `curl -X POST -H "Authorization: Bearer <klíč>" -d '{"rows":[]}' https://<adresa>/TEST`
>    → `{"pcs": []}`; se špatným klíčem 401.
> 3. Na každém mém PC zapiš `%USERPROFILE%\.claude\okna.json` s `{"sync": {"url": "https://<adresa>", "key": "<klíč>"}}`
>    (stávající obsah souboru zachovej). Klíč nevypisuj do chatu ani do logů, nedávej do gitu.
> 4. Řekni mi, ať v Claude spustím `/reload-plugins`.

## Přispívání

Nápady a chyby piš do [Issues](https://github.com/K3iVi/claude-okna/issues), úpravy posílej jako pull request —
viz [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

MIT — viz [LICENSE](LICENSE).

---

## English summary

**okna** is a Claude Code plugin for the desktop app (Windows) that adds an "Okna" (Windows) pane listing
all your sessions grouped by what they need from you: *waiting for you* (with the question), *working*,
*cache ending* (last active 50–60 min ago, cheap to continue now), *unread*, then folded *earlier* and
*deferred*. Click a row to open the session. Per row you can *defer* (move to "Deferred" until you write
into it) or *hide* it.

Optionally it shows sessions from your other PCs through a tiny sync server you run yourself
(`server/okna_server.py`, spec above) and opens them via Remote Control links. Without
`~/.claude/okna.json` nothing leaves your machine.

Install: `/plugin install okna --marketplace K3iVi/claude-okna`, then `/reload-plugins` and `/okna`.
The UI is in Czech; translations and macOS/Linux support are welcome as pull requests.
