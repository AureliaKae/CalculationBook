# CalculationBook (推演书)

> Enter the book as a guest. Write your own fate.

English | [简体中文](README.md)

[![CI](https://github.com/AureliaKae/CalculationBook/actions/workflows/ci.yml/badge.svg)](https://github.com/AureliaKae/CalculationBook/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/AureliaKae/CalculationBook)](https://github.com/AureliaKae/CalculationBook/releases)
[![License: MIT](https://img.shields.io/github/license/AureliaKae/CalculationBook?kill_cache=1)](LICENSE)

![Library desk](docs/screenshots/desk.png)

Turn a novel you've read into a world you can live in. Import a TXT or EPUB file; the engine reads the whole book, learns the prose style, files every character, and maps the timeline. Then you create a person the book never mentions and step in at chapter one. The original plot runs on schedule while you live your own life. Each turn you write what you want to do next, and a hidden die decides how it goes. A finished world exports as a `.cpworld` file you can send to friends ([format spec](docs/WORLD-FORMAT.md)).

Everything stays on your machine. Two things leave it: your own API key, and a public reference search at setup time (Wikipedia, Baidu Baike, DuckDuckGo).

## How it works

- **Three layers of intent**: what you want right now, your mid-term scheme, your goal for this life. Written and rewritten separately, injected at different stages. Clear intents are followed strictly; vague ones get shaped by your character's temperament.
- **Memory**: layered memory with BM25 retrieval. Each turn carries only the most relevant facts and recollections; notes on characters' whereabouts have a freshness window and expire silently.
- **Canon ledger**: four views of the original novel (now, upcoming, foreshadowing, past). Events arrive on the story clock. Options may not contradict canon or get ahead of it.
- **Hidden dice**: pick an option, the die rolls behind the curtain, and the result drives the narration. No stat panels anywhere; everything shows up in the prose.
- **Relationship ledger**: trust, interest, fear, and hostility accrue quietly. Six approaches (cooperate, persuade, deceive, threaten, resist, avoid) are interpreted by code into relationship changes.
- **Temperament**: Big Five traits drift with every choice. No personality gates; temperament only colors how vague intents land.
- **Emergence**: new stories, new faces, and companions grow out of play. Ventures you run register as storylines and gather influence turn by turn.
- **Changing fate**: buildup accumulates momentum; spend enough of it to rewrite an original event. Run out and fate pushes back. The past stays past.
- **Growth**: named inventory, learned skills, progression ladders, career paths. Whatever system the book has (realms, techniques, job grades), that's what grows. Advancement can be refused; refusal has a cost.
- **Ends and rebirth**: your epitaph becomes a world fact. On rebirth you keep your temperament, lose the body, and past lives leave traces in the world.
- **World extension**: five kinds of original entities (factions, roles, places, items, characters) enter the world archive and play by the same rules as canon, surviving across lives.

## Download

[Latest release](https://github.com/AureliaKae/CalculationBook/releases). Windows installer and portable build.

## Before you start

The engine ships no model. Bring your own DeepSeek or Qwen (Bailian) API key; it is stored encrypted on your machine.

## License

MIT.
