# Browser E2E

The following is a repeatable, headed-browser verification of the room flow. It uses the locally deployed application at `http://localhost:3001` and creates two independent browser contexts.

Start the local application first (for example, `docker compose up --build -d` if the project is deployed with Compose), then run these commands from the repository root:

```powershell
npx --yes --package @playwright/cli playwright-cli -s=bvwebchat-e2e open http://localhost:3001 --headed
npx --yes --package @playwright/cli playwright-cli -s=bvwebchat-e2e run-code --filename scripts/e2e/browser-room-flow.js
```

The flow creates a room, joins a second independent browser context, verifies both message directions, then leaves the room and verifies that the owner returns to `global`. A successful run prints a JSON result with `ok: true`.
