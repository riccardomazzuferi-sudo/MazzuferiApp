# PRD - MOLD ASSIST

## Original problem statement
App per attrezzisti e capiturno di un reparto di stampaggio ad iniezione plastica:
1. Risoluzione problemi qualitativi con soluzioni standard + storico + AI
2. Raccolta dati problemi/soluzioni per popolare il database
3. Schede di stampaggio scientifico basate su calcoli
4. Successivamente: parte per ufficio tecnico

## User personas
- **Attrezzista**: usa quotidianamente le schede stampaggio e risolve difetti a bordo pressa (tablet-friendly)
- **Capiturno**: consulta storico, gestisce anagrafiche, coordina interventi
- **Admin**: gestione completa

## Tech stack
- Backend: FastAPI + MongoDB (motor) + JWT auth + Claude Sonnet 4.6 (emergentintegrations)
- Frontend: React 19 + Tailwind + Shadcn UI + Phosphor Icons + i18n IT/EN
- PDF: jsPDF + jspdf-autotable (client side)

## Implemented (Feb 2026)
- Auth JWT (login, register, me) con seed admin/admin123 e attrezzista/test123
- Anagrafiche CRUD: Presse, Stampi, Materiali (4 preseeded: PP-H, ABS, PC, PA6)
- Catalogo difetti (10 preseeded) con soluzioni standard
- Storico problemi/soluzioni con filtri (difetto/materiale)
- Defect Solver a 3 colonne: soluzioni standard + storico + AI (streaming Claude Sonnet 4.6 in italiano/inglese)
- Scheda Stampaggio Scientifico: calcoli Ø vite ottimale (cristallino/amorfo), CM, QSCM, Qcomm, Vper/RPM, profilo temperature multi-zona, Qmax, Vmax iniezione, TMP mantenimento (cristallini/amorfi), TRr raffreddamento reale
- Salvataggio schede + esportazione PDF completa
- UI industriale slate/blue con font Chivo + IBM Plex Sans + JetBrains Mono
- Switch lingua IT/EN

## P1 backlog (per prossime iterazioni)
- Integrare contenuti dalla versione claude (cycletime-pro) di riferimento fornita dall'utente
- Caricare manuale difetti (secondo upload previsto) per arricchire soluzioni standard
- Parte per ufficio tecnico (post-fase attuale)
- Analytics: frequenza difetti per materiale/stampo/pressa
- Comparazione schede stampaggio (delta parametri)
- Import/export CSV delle anagrafiche
- Ruoli granulari (attrezzista vs capiturno vs admin)

## Files
- /app/backend/server.py: tutti gli endpoints
- /app/frontend/src/pages/{Login,Dashboard,DefectSolver,MoldingSheet,History,Registries}.jsx
- /app/frontend/src/i18n.js: traduzioni IT/EN
- /app/memory/test_credentials.md: credenziali di test
