# FoundryDeck Module

The Foundry VTT component of **FoundryDeck**. This module allows you to trigger automated actions, run macros, toggle playlists, play sounds, and execute generic scripts remotely.

## 🔗 The FoundryDeck Ecosystem

FoundryDeck is split into three interconnected parts to bypass firewall restrictions and allow seamless remote control:
1. **[FoundryDeck Companion](https://github.com/ErlendT/foundrydeck-companion)**: The Bitfocus Companion plugin that provides the Stream Deck interface.
2. **[FoundryDeck Relay](https://github.com/ErlendT/foundrydeck-relay)**: A standalone WebSocket server designed to bridge the companion with the Foundry VTT instance.
3. **[FoundryDeck Module](https://github.com/ErlendT/foundrydeck-module)** (This repo): The Foundry VTT add-on that receives actions from the relay and executes them in-game.

### How it works:
1. You press a button on your Stream Deck.
2. The **Companion** module sends a WebSocket message to the **Relay**.
3. The **Relay** forwards the message over an established WebSocket connection to this **Foundry Module**.
4. This **Foundry Module** executes the macro, toggles the playlist, or rolls the dice.
