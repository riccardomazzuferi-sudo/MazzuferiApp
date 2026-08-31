from fastapi import FastAPI, APIRouter, HTTPException, Depends, Header
from fastapi.responses import StreamingResponse
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field
from typing import List, Optional, Literal
from pathlib import Path
from datetime import datetime, timezone, timedelta
import os
import json
import logging
import uuid
import math
import bcrypt
import jwt as pyjwt
import httpx

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

MONGO_URL = os.environ['MONGO_URL']
DB_NAME = os.environ['DB_NAME']
JWT_SECRET = os.environ['JWT_SECRET']
# Chiave API gratuita di Google AI Studio (https://aistudio.google.com/apikey) per il
# "Risolvi difetti" con AI. Se non impostata, l'endpoint risponde con un messaggio
# esplicativo invece di generare un errore: il resto dell'app funziona comunque.
GEMINI_API_KEY = os.environ.get('GEMINI_API_KEY', '')
GEMINI_MODEL = os.environ.get('GEMINI_MODEL', 'gemini-2.5-flash')

client = AsyncIOMotorClient(MONGO_URL)
db = client[DB_NAME]

app = FastAPI(title="Mold Assist API")
api_router = APIRouter(prefix="/api")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


# =========================================================
# AUTH
# =========================================================
def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def create_token(user_id: str, username: str, role: str) -> str:
    payload = {
        "sub": user_id,
        "username": username,
        "role": role,
        "exp": datetime.now(timezone.utc) + timedelta(days=30),
    }
    return pyjwt.encode(payload, JWT_SECRET, algorithm="HS256")


async def get_current_user(authorization: Optional[str] = Header(None)) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing token")
    token = authorization.split(" ", 1)[1]
    try:
        payload = pyjwt.decode(token, JWT_SECRET, algorithms=["HS256"])
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token")
    user = await db.users.find_one({"id": payload["sub"]}, {"_id": 0, "password": 0})
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user


class LoginBody(BaseModel):
    username: str
    password: str


class RegisterBody(BaseModel):
    username: str
    password: str
    full_name: str
    role: Literal["attrezzista", "capiturno", "tecnico", "admin"] = "attrezzista"


@api_router.post("/auth/register")
async def register(body: RegisterBody):
    exists = await db.users.find_one({"username": body.username})
    if exists:
        raise HTTPException(status_code=400, detail="Username già in uso")
    hashed = bcrypt.hashpw(body.password.encode(), bcrypt.gensalt()).decode()
    user = {
        "id": str(uuid.uuid4()),
        "username": body.username,
        "password": hashed,
        "full_name": body.full_name,
        "role": body.role,
        "created_at": now_iso(),
    }
    await db.users.insert_one(user)
    token = create_token(user["id"], user["username"], user["role"])
    return {"token": token, "user": {k: v for k, v in user.items() if k != "password"}}


@api_router.post("/auth/login")
async def login(body: LoginBody):
    user = await db.users.find_one({"username": body.username})
    if not user or not bcrypt.checkpw(body.password.encode(), user["password"].encode()):
        raise HTTPException(status_code=401, detail="Credenziali non valide")
    token = create_token(user["id"], user["username"], user["role"])
    return {
        "token": token,
        "user": {
            "id": user["id"],
            "username": user["username"],
            "full_name": user["full_name"],
            "role": user["role"],
        },
    }


@api_router.get("/auth/me")
async def me(user: dict = Depends(get_current_user)):
    return user


# =========================================================
# ANAGRAFICHE (Registries)
# =========================================================
class Press(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    code: str
    name: str
    tonnage: float  # tonnellaggio
    screw_diameter: float  # mm
    screw_area: Optional[float] = None  # cm² (auto)
    max_stroke: float  # corsa max mm
    max_rpm: float  # nmax rot vite
    qmax: float  # cm³/s max flow rate of press
    max_injection_pressure: Optional[float] = None  # bar
    notes: Optional[str] = ""
    created_at: str = Field(default_factory=now_iso)


class Mold(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    code: str
    name: str
    cavities: int  # N° figure
    flows_per_cavity: int = 1  # N° flussi
    part_weight: float  # gr (per singola cavità)
    part_thickness: float  # mm (spessore medio)
    ejection_thickness: Optional[float] = None  # mm, defaults to part_thickness
    runner_section: Optional[float] = None  # cm² sezione trasversale
    projected_area: Optional[float] = None  # cm²
    notes: Optional[str] = ""
    created_at: str = Field(default_factory=now_iso)


class Material(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    code: str
    name: str
    family: Optional[str] = ""  # es. PP, ABS, PC...
    material_type: Literal["cristallino", "amorfo"]
    # Densità
    density_liquid: float  # Dliq gr/cm³
    density_solid: float  # Dsol gr/cm³
    density_apparent: Optional[float] = None  # denA gr/cm³ (densità apparente/bulk)
    # Fattori per raffreddamento
    thermal_factor_a: float  # A mm²/s (per calcolo raffreddamento reale TRr)
    # Cristallizzazione (solo cristallini)
    crystallization_velocity: Optional[float] = None  # Vcrist s/mm
    # Temperature
    melt_temp_min: float  # °C ta min
    melt_temp_recommended: Optional[float] = None  # °C ta consigliata
    melt_temp_max: float  # °C ta max
    mold_temp_min: float  # °C ts min
    mold_temp_recommended: Optional[float] = None  # °C ts consigliata (tspo)
    mold_temp_max: float  # °C ts max
    ejection_temp: float  # °C temperatura di estrazione (testr)
    # Ritiro
    shrink_long: Optional[float] = None  # % longitudinale
    shrink_transverse: Optional[float] = None  # % trasversale
    # Velocità
    max_peripheral_speed: float = 0.3  # Vper m/s
    real_peripheral_speed: Optional[float] = None  # VperReale m/s
    front_velocity: Optional[float] = None  # velAf cm/s (avanzamento fronte)
    # Pressioni mantenimento
    pp1_min: Optional[float] = None  # bar (specifica)
    pp1_max: Optional[float] = None  # bar
    # Delta profilo temperature
    dt_profile: Optional[float] = 30.0  # dTp °C (delta totale del profilo)
    # Plastificazione
    heat_plastification: Optional[float] = None  # calorePlast kJ/kg
    screw_ingress_temp: Optional[float] = None  # tingrVite °C
    # Essiccazione
    dry_temp: Optional[float] = None  # pressEssTem °C
    dry_time: Optional[float] = None  # pressEssTpo ore
    # Permanenza / vita in cilindro
    max_barrel_use_pct: Optional[float] = None  # macMax % max sfruttamento capacità
    max_residence_time: Optional[float] = None  # tpmv min (tempo massimo permanenza)
    notes: Optional[str] = ""
    created_at: str = Field(default_factory=now_iso)


def _crud_endpoints(name: str, collection: str, model_cls):
    @api_router.get(f"/{name}")
    async def list_items(user: dict = Depends(get_current_user)):
        items = await db[collection].find({}, {"_id": 0}).sort("created_at", -1).to_list(1000)
        return items

    @api_router.post(f"/{name}")
    async def create_item(body: model_cls, user: dict = Depends(get_current_user)):
        doc = body.model_dump()
        # auto compute screw_area for presses
        if name == "presses" and doc.get("screw_diameter"):
            d = doc["screw_diameter"] / 10.0  # mm -> cm
            doc["screw_area"] = math.pi * (d / 2) ** 2
        await db[collection].insert_one({**doc})
        return doc

    @api_router.put(f"/{name}/{{item_id}}")
    async def update_item(item_id: str, body: model_cls, user: dict = Depends(get_current_user)):
        doc = body.model_dump()
        doc["id"] = item_id
        if name == "presses" and doc.get("screw_diameter"):
            d = doc["screw_diameter"] / 10.0
            doc["screw_area"] = math.pi * (d / 2) ** 2
        await db[collection].update_one({"id": item_id}, {"$set": doc})
        return doc

    @api_router.delete(f"/{name}/{{item_id}}")
    async def delete_item(item_id: str, user: dict = Depends(get_current_user)):
        await db[collection].delete_one({"id": item_id})
        return {"ok": True}


_crud_endpoints("presses", "presses", Press)
_crud_endpoints("molds", "molds", Mold)
_crud_endpoints("materials", "materials", Material)


# =========================================================
# DEFECTS CATALOG + STANDARD SOLUTIONS
# =========================================================
class Defect(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    code: str
    name_it: str
    name_en: str
    description_it: str
    description_en: str
    category: Optional[str] = None  # sezione del manuale difetti (es. "Difetti funzionali")
    standard_solutions: List[str] = []  # in italiano
    created_at: str = Field(default_factory=now_iso)


@api_router.get("/defects")
async def list_defects(user: dict = Depends(get_current_user)):
    items = await db.defects.find({}, {"_id": 0}).sort("code", 1).to_list(1000)
    return items


@api_router.post("/defects")
async def create_defect(body: Defect, user: dict = Depends(get_current_user)):
    doc = body.model_dump()
    await db.defects.insert_one({**doc})
    return doc


# =========================================================
# PROBLEM REPORTS (Storico problemi/soluzioni)
# =========================================================
class ProblemReport(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    defect_id: str
    defect_name: str
    press_id: Optional[str] = None
    press_name: Optional[str] = None
    mold_id: Optional[str] = None
    mold_name: Optional[str] = None
    material_id: Optional[str] = None
    material_name: Optional[str] = None
    description: str
    solution_applied: str
    solved: bool = True
    operator_name: str
    created_at: str = Field(default_factory=now_iso)


@api_router.get("/problems")
async def list_problems(
    defect_id: Optional[str] = None,
    material_id: Optional[str] = None,
    mold_id: Optional[str] = None,
    user: dict = Depends(get_current_user),
):
    q = {}
    if defect_id: q["defect_id"] = defect_id
    if material_id: q["material_id"] = material_id
    if mold_id: q["mold_id"] = mold_id
    items = await db.problems.find(q, {"_id": 0}).sort("created_at", -1).to_list(500)
    return items


@api_router.post("/problems")
async def create_problem(body: ProblemReport, user: dict = Depends(get_current_user)):
    doc = body.model_dump()
    await db.problems.insert_one({**doc})
    return doc


@api_router.delete("/problems/{pid}")
async def delete_problem(pid: str, user: dict = Depends(get_current_user)):
    await db.problems.delete_one({"id": pid})
    return {"ok": True}


# =========================================================
# AI DEFECT RESOLVER (Google Gemini — livello gratuito, nessuna carta richiesta)
# =========================================================
class AIResolveBody(BaseModel):
    defect_id: str
    description: str
    material_id: Optional[str] = None
    mold_id: Optional[str] = None
    press_id: Optional[str] = None
    language: Literal["it", "en"] = "it"


@api_router.post("/ai/resolve-defect")
async def ai_resolve(body: AIResolveBody, user: dict = Depends(get_current_user)):
    if not GEMINI_API_KEY:
        async def gen_unconfigured():
            yield ("Funzione AI non ancora configurata: manca la chiave GEMINI_API_KEY "
                   "sul server (gratuita su https://aistudio.google.com/apikey). "
                   "Le altre funzioni dell'app non sono interessate.")
        return StreamingResponse(gen_unconfigured(), media_type="text/plain; charset=utf-8")

    defect = await db.defects.find_one({"id": body.defect_id}, {"_id": 0})
    if not defect:
        raise HTTPException(status_code=404, detail="Defect not found")

    material = await db.materials.find_one({"id": body.material_id}, {"_id": 0}) if body.material_id else None
    mold = await db.molds.find_one({"id": body.mold_id}, {"_id": 0}) if body.mold_id else None
    press = await db.presses.find_one({"id": body.press_id}, {"_id": 0}) if body.press_id else None

    history = await db.problems.find(
        {"defect_id": body.defect_id}, {"_id": 0}
    ).sort("created_at", -1).limit(15).to_list(15)

    lang = "italiano" if body.language == "it" else "english"
    sys_msg = f"""Sei un esperto tecnico di stampaggio ad iniezione plastica con 30 anni di esperienza.
Rispondi SEMPRE in {lang}. Sei conciso, pratico e ti rivolgi ad attrezzisti e capiturno di reparto.
Il tuo compito è proporre soluzioni concrete e ordinate PER PRIORITÀ per risolvere un difetto di stampaggio.
Struttura la risposta OBBLIGATORIAMENTE così:

## Cause probabili
- (elenco puntato, max 5)

## Soluzioni consigliate (ordinate per priorità)
1. **Azione**: descrizione breve
2. ...

## Parametri da verificare
- (elenco puntato di parametri macchina/stampo)

Basati sulle soluzioni standard fornite e sullo storico. NON inventare procedure pericolose. Se il difetto non è chiaro, chiedi info aggiuntive."""

    ctx_parts = [f"DIFETTO: {defect['name_it']} ({defect['code']})",
                 f"Descrizione difetto standard: {defect['description_it']}",
                 f"Soluzioni standard da manuale:\n" + "\n".join(f"- {s}" for s in defect.get('standard_solutions', []))]
    if material:
        ctx_parts.append(f"\nMATERIALE: {material['name']} ({material['family']}) - tipo {material['material_type']}, Tstampaggio {material['melt_temp_min']}-{material['melt_temp_max']}°C, Tstampo {material['mold_temp_min']}-{material['mold_temp_max']}°C")
    if mold:
        ctx_parts.append(f"STAMPO: {mold['name']} - {mold['cavities']} cavità, peso pezzo {mold['part_weight']}g, spessore {mold['part_thickness']}mm")
    if press:
        ctx_parts.append(f"PRESSA: {press['name']} - {press['tonnage']}T, vite Ø{press['screw_diameter']}mm")

    if history:
        ctx_parts.append("\n\nSTORICO SOLUZIONI APPLICATE PER QUESTO DIFETTO:")
        for h in history[:10]:
            ctx_parts.append(f"- [{h.get('material_name','n/d')} / {h.get('mold_name','n/d')}] {h['description'][:120]} → soluzione: {h['solution_applied'][:200]} (esito: {'OK' if h.get('solved') else 'KO'})")

    ctx_parts.append(f"\n\nDESCRIZIONE DEL PROBLEMA ATTUALE (dall'operatore):\n{body.description}")

    context = "\n".join(ctx_parts)

    gemini_url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:streamGenerateContent"
        f"?alt=sse&key={GEMINI_API_KEY}"
    )
    gemini_body = {
        "systemInstruction": {"parts": [{"text": sys_msg}]},
        "contents": [{"role": "user", "parts": [{"text": context}]}],
        "generationConfig": {"temperature": 0.4},
    }

    async def gen():
        try:
            async with httpx.AsyncClient(timeout=60.0) as client_http:
                async with client_http.stream("POST", gemini_url, json=gemini_body) as resp:
                    if resp.status_code != 200:
                        err_text = await resp.aread()
                        logger.error("Gemini API error %s: %s", resp.status_code, err_text[:500])
                        yield f"\n\n[Errore AI: risposta {resp.status_code} da Gemini]"
                        return
                    async for line in resp.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        payload = line[len("data:"):].strip()
                        if not payload or payload == "[DONE]":
                            continue
                        try:
                            chunk = json.loads(payload)
                        except json.JSONDecodeError:
                            continue
                        for cand in chunk.get("candidates", []):
                            for part in cand.get("content", {}).get("parts", []):
                                text = part.get("text")
                                if text:
                                    yield text
        except Exception as e:
            logger.exception("AI resolve error")
            yield f"\n\n[Errore AI: {str(e)}]"

    return StreamingResponse(
        gen(),
        media_type="text/plain; charset=utf-8",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# =========================================================
# SCIENTIFIC MOLDING CALCULATOR
# =========================================================
class MoldingCalcBody(BaseModel):
    press_id: str
    mold_id: str
    material_id: str
    cushion: float = 5.0  # mm
    fill_time_target: Optional[float] = None  # s, opzionale
    real_cycle_time: Optional[float] = None  # s, opzionale, per T.permanenza reale
    thin_section_thickness: Optional[float] = None  # mm, per TMP sezione sottile
    psi_pi_ratio: float = 10.0  # rapporto pressione specifica / pressione idraulica
    injection_pressure: Optional[float] = None  # bar idraulica
    machine_max_flow: Optional[float] = None  # override Qmax pressa


# Tabella diametri vite commerciali → sezione (cm²)
SEZ_VITE_TABLE = {
    15: 1.77, 18: 2.54, 20: 3.14, 22: 3.80, 25: 4.91, 28: 6.16, 30: 7.07,
    32: 8.04, 35: 9.62, 40: 12.57, 45: 15.90, 50: 19.63, 55: 23.76,
    60: 28.27, 65: 33.18, 70: 38.48, 75: 44.18, 80: 50.27, 90: 63.62, 100: 78.54,
}


def get_dmin_dmax(d_ideale: float):
    """Restituisce i due diametri commerciali che racchiudono il valore ideale."""
    keys = sorted(SEZ_VITE_TABLE.keys())
    dmin, dmax = keys[0], keys[-1]
    for k in keys:
        if k <= d_ideale:
            dmin = k
    for k in keys:
        if k >= d_ideale:
            dmax = k
            break
    return dmin, dmax


@api_router.post("/molding/calculate")
async def calc_molding(body: MoldingCalcBody, user: dict = Depends(get_current_user)):
    press = await db.presses.find_one({"id": body.press_id}, {"_id": 0})
    mold = await db.molds.find_one({"id": body.mold_id}, {"_id": 0})
    material = await db.materials.find_one({"id": body.material_id}, {"_id": 0})
    if not (press and mold and material):
        raise HTTPException(status_code=404, detail="Pressa, stampo o materiale non trovato")

    # Peso totale stampata = peso pezzo * n cavità
    part_weight_total = mold["part_weight"] * mold["cavities"]
    Dliq = material["density_liquid"]
    Dsol = material["density_solid"]

    # === D vite ottimale (Cristallini/Amorfi) + range commerciale Dmin/Dmax ===
    coef = 1.59 if material["material_type"] == "cristallino" else 0.64
    optimal_screw_d = 10 * (coef * part_weight_total / Dliq) ** (1 / 3)
    dmin, dmax = get_dmin_dmax(optimal_screw_d)

    # Sezione vite pressa: se il diametro è in tabella usa quella, altrimenti π·(d/2)²
    d_press = press["screw_diameter"]
    if d_press in SEZ_VITE_TABLE:
        screw_area = SEZ_VITE_TABLE[d_press]
    else:
        d_cm = d_press / 10.0
        screw_area = math.pi * (d_cm / 2) ** 2

    # === Dosaggio: CM, cuscino, QSCM, Q commutazione ===
    cm_mm = (part_weight_total * 10) / (screw_area * Dliq)
    cm_cm3 = part_weight_total / Dliq
    qscm = cm_mm + body.cushion
    qscm_cm3 = qscm * screw_area / 10
    cushion_cm3 = body.cushion * screw_area / 10
    q_comm = qscm - (cm_mm * Dliq / Dsol)
    q_comm_cm3 = q_comm * screw_area / 10

    # === Velocità periferica vite / RPM ideali ===
    vper_target = material["max_peripheral_speed"]  # m/s
    n_ideal_rpm = (vper_target * 100) / (0.523 * (d_press / 100))
    vper_m_min = vper_target * 60
    n_percent = (n_ideal_rpm / press["max_rpm"]) * 100 if press.get("max_rpm") else None

    # === Profilo temperatura 5 zone U/A/B/C/D (formula vademecum: DT = (nD-2)·30) ===
    # TA = temperatura di stampaggio (consigliata se disponibile)
    TA = material.get("melt_temp_recommended") or (material["melt_temp_min"] + material["melt_temp_max"]) / 2
    nD = cm_mm / d_press if d_press else 2
    nD = max(1.0, min(3.0, nD))
    DT = (nD - 2) * 30
    dt = DT / 4
    temp_profile = [
        {"zone": "U", "label": "Ugello", "temp_c": round(TA, 1)},
        {"zone": "A", "label": "Zona A", "temp_c": round(TA + dt * 1, 1)},
        {"zone": "B", "label": "Zona B", "temp_c": round(TA + dt * 2, 1)},
        {"zone": "C", "label": "Zona C", "temp_c": round(TA + dt * 3, 1)},
        {"zone": "D", "label": "Tramoggia", "temp_c": round(TA + dt * 4, 1)},
    ]

    # === Qmax teorico ===
    vol_stampata = part_weight_total / Dsol  # cm³
    # Uso velAf se disponibile per stimare tempo riempimento teorico
    fill_time_theoretical = None
    if material.get("front_velocity") and mold.get("part_thickness"):
        # Semplificazione: stima con L_perc = 100mm default se non fornito
        fill_time_theoretical = 10 / material["front_velocity"]  # 10 cm / (cm/s)
    fill_time = body.fill_time_target or fill_time_theoretical or max(0.5, min(3.0, mold["part_thickness"] * 0.3))
    qmax = vol_stampata / fill_time
    qmax_half = qmax / 2  # per Qmax/2 amorfi

    # Vmax velocità iniezione lineare mm/s
    vmax_mm_s = (qmax / screw_area) * 10 if screw_area else 0
    press_qmax = body.machine_max_flow or press.get("qmax") or 100
    vmax_percent = (qmax / press_qmax) * 100 if press_qmax else None

    # === Pressione specifica iniezione (Psi = Pi × rapporto Psi/Pi) ===
    press_spec_iniez = None
    if body.injection_pressure and body.psi_pi_ratio:
        press_spec_iniez = body.injection_pressure * body.psi_pi_ratio

    # === Forza di chiusura teorica (kN) se area proiettata disponibile ===
    forza_chiusura_kn = None
    if mold.get("projected_area") and press_spec_iniez:
        # Area × Press.spec × N.cavità × 0.1 / 9.81 → kN
        area_tot = mold["projected_area"] * mold.get("cavities", 1)
        forza_chiusura_kn = area_tot * press_spec_iniez * 0.1 / 9.81

    # === Tempo mantenimento: teorico + economico + sezione sottile ===
    sp = mold["part_thickness"]
    is_cristallino = material["material_type"] == "cristallino"
    if is_cristallino:
        vc = material.get("crystallization_velocity") or 0.6
        tmp_teorico = sp * vc
        tmp_economico = sp * vc  # per cristallini è la stessa formula
        tmp_sez_sottile = (body.thin_section_thickness or sp) * vc if body.thin_section_thickness else None
    else:
        # Amorfi: Sp × T.riemp (usando Qmax/2 per teorico)
        t_riemp_qhalf = vol_stampata / qmax_half if qmax_half else fill_time
        tmp_teorico = sp * t_riemp_qhalf
        tmp_economico = sp * fill_time
        tmp_sez_sottile = (body.thin_section_thickness * fill_time) if body.thin_section_thickness else None

    tmp = tmp_economico  # usato nel bilancio ciclo

    # === Tempo raffreddamento reale (TRr) ===
    sp_estr = mold.get("ejection_thickness") or mold["part_thickness"]
    A = material["thermal_factor_a"]
    Tmassa = (material.get("melt_temp_recommended") or material["melt_temp_max"]) + 40
    Tstpo = material.get("mold_temp_recommended") or (material["mold_temp_min"] + material["mold_temp_max"]) / 2
    Testr = material["ejection_temp"]
    try:
        ln_arg = (Tmassa - Tstpo) / max(0.01, (Testr - Tstpo))
        trr = ((sp_estr ** 2) / A) * math.log(max(1.0001, ln_arg))
    except Exception:
        trr = 0
    traff = max(0.0, trr - tmp)

    # === Tempo di ciclo teorico + Tempo di permanenza in cilindro ===
    # T.ciclo = TMP + Traff + tempi accessori (stimati)
    accessory_time = 5.0  # s (aperture/chiusura/estrazione stimati)
    t_ciclo_teorico = tmp + traff + accessory_time
    mac_max = material.get("max_barrel_use_pct")
    tpmv_max = material.get("max_residence_time")  # min

    t_permanenza_teorica = None
    t_permanenza_reale = None
    permanenza_warning = None
    if mac_max:
        t_permanenza_teorica = (t_ciclo_teorico / 60) * (100 / mac_max)  # min
        if body.real_cycle_time:
            t_permanenza_reale = (body.real_cycle_time / 60) * (100 / mac_max)
        if tpmv_max:
            check_t = t_permanenza_reale if t_permanenza_reale else t_permanenza_teorica
            if check_t > tpmv_max:
                permanenza_warning = f"⚠ Permanenza {check_t:.1f} min > massimo consentito {tpmv_max} min per {material['name']} — rischio degrado"

    result = {
        "id": str(uuid.uuid4()),
        "press": press,
        "mold": mold,
        "material": material,
        "inputs": body.model_dump(),
        "results": {
            "part_weight_total_g": round(part_weight_total, 3),
            "optimal_screw_diameter_mm": round(optimal_screw_d, 2),
            "dmin_mm": dmin,
            "dmax_mm": dmax,
            "screw_area_cm2": round(screw_area, 3),
            "cm_mm": round(cm_mm, 2),
            "cm_cm3": round(cm_cm3, 3),
            "qscm_mm": round(qscm, 2),
            "qscm_cm3": round(qscm_cm3, 3),
            "q_comm_mm": round(q_comm, 2),
            "q_comm_cm3": round(q_comm_cm3, 3),
            "cushion_mm": body.cushion,
            "cushion_cm3": round(cushion_cm3, 3),
            "vper_target_m_s": round(vper_target, 3),
            "vper_m_min": round(vper_m_min, 2),
            "n_ideal_rpm": round(n_ideal_rpm, 1),
            "n_percent": round(n_percent, 1) if n_percent else None,
            "nD": round(nD, 2),
            "temp_profile": temp_profile,
            "ta_stampaggio": round(TA, 1),
            "vol_stampata_cm3": round(vol_stampata, 3),
            "fill_time_s": round(fill_time, 3),
            "qmax_cm3_s": round(qmax, 2),
            "qmax_half_cm3_s": round(qmax_half, 2),
            "vmax_mm_s": round(vmax_mm_s, 2),
            "vmax_percent": round(vmax_percent, 1) if vmax_percent else None,
            "press_spec_iniez_bar": round(press_spec_iniez, 1) if press_spec_iniez else None,
            "forza_chiusura_kn": round(forza_chiusura_kn, 1) if forza_chiusura_kn else None,
            "tmp_teorico_s": round(tmp_teorico, 2),
            "tmp_economico_s": round(tmp_economico, 2),
            "tmp_sez_sottile_s": round(tmp_sez_sottile, 2) if tmp_sez_sottile else None,
            "trr_s": round(trr, 2),
            "traff_s": round(traff, 2),
            "t_ciclo_teorico_s": round(t_ciclo_teorico, 2),
            "t_permanenza_teorica_min": round(t_permanenza_teorica, 2) if t_permanenza_teorica else None,
            "t_permanenza_reale_min": round(t_permanenza_reale, 2) if t_permanenza_reale else None,
            "tpmv_max_min": tpmv_max,
            "permanenza_warning": permanenza_warning,
            "melt_temp_avg": round(TA, 1),
            "mold_temp_avg": round(Tstpo, 1),
            "material_type": material["material_type"],
        },
        "created_at": now_iso(),
        "created_by": user["username"],
    }
    return result


class SavedSheet(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str
    payload: dict
    created_at: str = Field(default_factory=now_iso)


@api_router.post("/molding/save")
async def save_sheet(body: SavedSheet, user: dict = Depends(get_current_user)):
    doc = body.model_dump()
    doc["created_by"] = user["username"]
    await db.molding_sheets.insert_one({**doc})
    return doc


@api_router.get("/molding/sheets")
async def list_sheets(user: dict = Depends(get_current_user)):
    items = await db.molding_sheets.find({}, {"_id": 0}).sort("created_at", -1).to_list(200)
    return items


@api_router.delete("/molding/sheets/{sid}")
async def delete_sheet(sid: str, user: dict = Depends(get_current_user)):
    await db.molding_sheets.delete_one({"id": sid})
    return {"ok": True}


# =========================================================
# SEED DATA (defects catalog + admin)
# =========================================================
DEFECT_SEED = [
    # =====================================================================
    # 11.5 DIFETTI FUNZIONALI
    # =====================================================================
    {"code": "F1.1", "name_it": "Pezzo incompleto o non completamente formato", "name_en": "Short shot / incomplete part",
     "category": "Difetti funzionali",
     "description_it": "Il pezzo non appare completo: presenta mancanze di materiale, soprattutto all'estremità del percorso di flusso o nei punti di parete sottile, anche diverse tra un pezzo e l'altro.",
     "description_en": "The part is not fully formed: material is missing, especially at the end of the flow path or at thin-wall sections, sometimes differently from piece to piece.",
     "standard_solutions": [
         "Verificare se si deve aumentare il dosaggio del materiale (cuscinetto)",
         "Verificare se si può elevare la temperatura del cilindro di plastificazione",
         "Verificare se si può elevare il valore della contropressione",
         "Verificare se si può elevare la temperatura dello stampo",
         "Verificare se si può elevare la temperatura dell'ugello",
         "Verificare se si può elevare la velocità d'iniezione",
         "Elevare il valore della pressione d'iniezione, oppure creare un picco al punto di commutazione (solo se ci sono difficoltà di riempimento nella parte finale del percorso)",
         "Verificare se il foro di uscita materiale dell'ugello è parzialmente intasato",
         "Utilizzare ugelli con foro di uscita materiale di sezione maggiorata",
         "Verificare la centratura dello stampo",
         "Verificare se si deve aumentare la sezione del punto d'iniezione",
         "Verificare il corretto funzionamento degli sfoghi d'aria di impronta",
         "Eseguire nuovi sfoghi d'aria nell'impronta, se necessario",
     ]},
    {"code": "F1.2", "name_it": "Pezzo sotto peso", "name_en": "Underweight part",
     "category": "Difetti funzionali",
     "description_it": "Il pezzo appare completo nelle forme ma non raggiunge il peso corretto corrispondente alla sua densità solida.",
     "description_en": "The part looks complete but does not reach the correct weight for its solid density.",
     "standard_solutions": [
         "Controllare che il cuscinetto non sia ridotto a zero",
         "Aumentare il TMP (tempo di mantenimento in pressione)",
         "Aumentare il valore di Post-pressione 1 fino al massimo consentito",
         "Aumentare il TMP corrispondente al nuovo valore di PP1",
     ]},
    {"code": "F1.3", "name_it": "Pezzo sotto-dimensionato", "name_en": "Undersized part",
     "category": "Difetti funzionali",
     "description_it": "Il pezzo può essere anche sotto peso, ma qui il vincolo più stringente sono le dimensioni, che devono rientrare nelle tolleranze prescritte.",
     "description_en": "The part may also be underweight, but the binding constraint here is dimensional tolerance.",
     "standard_solutions": [
         "Verificare il ritiro adottato sullo stampo e confrontarlo con quello del materiale",
         "Aumentare la temperatura di stampaggio",
         "Aumentare il valore di contropressione",
         "Aumentare la velocità d'iniezione",
         "Aumentare la pressione d'iniezione",
         "Aumentare il valore di Post-pressione 1",
         "Verificare se si può aumentare il TMP (tempo di mantenimento)",
         "Diminuire la temperatura dello stampo",
         "Allargare il punto d'iniezione",
     ]},
    {"code": "F1.4", "name_it": "Pezzo sovra-dimensionato", "name_en": "Oversized part",
     "category": "Difetti funzionali",
     "description_it": "Cause: ritiro adottato sullo stampo elevato; temperature troppo elevate; velocità d'iniezione elevate; pressioni di mantenimento elevate; TMP elevato; temperatura stampo bassa.",
     "description_en": "Causes: mold shrinkage set too high; temperatures too high; high injection speed; high holding pressure; long TMP; low mold temperature.",
     "standard_solutions": [
         "Verificare il ritiro adottato sullo stampo e confrontarlo con quello del materiale usato",
         "Ridurre la temperatura di stampaggio",
         "Ridurre la velocità d'iniezione",
         "Ridurre la pressione d'iniezione",
         "Ridurre il valore di Post-pressione 1",
         "Ridurre il TMP (tempo di mantenimento)",
         "Aumentare la temperatura dello stampo",
     ]},
    {"code": "F1.5", "name_it": "Pezzo sovraimpaccato con bave o pellicole", "name_en": "Overpacked part with flash or film",
     "category": "Difetti funzionali",
     "description_it": "Formazione di pellicole di materiale plastico su fessure dello stampo (piani di separazione, estrattori, sfoghi d'aria); le bave possono avere dimensioni variabili. Attenzione: anche una formazione di bave breve nel tempo può danneggiare le superfici del piano di separazione dello stampo.",
     "description_en": "Thin plastic film forms on mold gaps (parting line, ejectors, air vents); flash can vary widely in size. Even brief flash formation can damage the mold's parting-line surfaces.",
     "standard_solutions": [
         "Verificare se esistono problemi di chiusura dello stampo",
         "Verificare se si deve aumentare la forza di chiusura dello stampo",
         "Eliminare il picco di pressione d'iniezione alla commutazione",
         "Ridurre la temperatura di stampaggio",
         "Ridurre la velocità d'iniezione in riempimento (profilo lento-veloce)",
         "Anticipare il punto di commutazione",
         "Ridurre il valore della pressione di mantenimento (PP1)",
         "Ridurre il valore del TMP (solo per materiali amorfi)",
         "Ridurre la temperatura dello stampo",
         "Ritoccare lo stampo nell'ambito delle superfici di separazione",
     ]},
    {"code": "F1.6", "name_it": "Pezzo con deformazioni o svergolamenti", "name_en": "Warped / distorted part",
     "category": "Difetti funzionali",
     "description_it": "Le superfici del pezzo non rispettano parallelismo o perpendicolarità: distorsioni angolari, ondulazioni, concavità, bombature. Cause: tensioni interne che si creano durante il riempimento e non vengono eliminate in mantenimento; chiusura di sezioni cristalline; temperatura di stampaggio elevata; velocità e pressioni d'iniezione alte; spessori diversi con ritiri diversi.",
     "description_en": "Part surfaces lose parallelism or perpendicularity: angular distortion, waviness, concavity, bowing. Caused by internal stresses from filling that aren't relieved during holding, uneven wall thickness, and process settings too aggressive.",
     "standard_solutions": [
         "Verificare l'eventuale chiusura di sezioni coi materiali cristallini (in questo caso serve modificare lo stampo)",
         "Diminuire la temperatura di stampaggio",
         "Ridurre la velocità d'iniezione",
         "Diminuire o eliminare l'eventuale picco di pressione d'iniezione",
         "Verificare i valori di Post-pressione e i relativi tempi",
         "Verificare se si può diminuire la temperatura dello stampo, o differenziarla in funzione degli spessori (più calda dove lo spessore è maggiore, più fredda dove è minore)",
         "Verificare se si deve aumentare il tempo di raffreddamento",
         "Spostare il punto d'iniezione sullo spessore del pezzo più grande",
         "Inserire nervature che conducano il materiale, dal punto d'iniezione, verso gli spessori più grandi",
         "Allargare la sezione dei canali equagliandoli allo spessore più grande del manufatto",
         "Raccordare circolarmente il canale di alimentazione in prossimità del punto d'iniezione per impedire che si chiuda la sezione più sottile",
     ]},
    {"code": "F1.7", "name_it": "Pezzo con fessurazioni o criccature interne (crazing)", "name_en": "Cracking / crazing",
     "category": "Difetti funzionali",
     "description_it": "Tendenza alla fessurazione tipica dei termoplastici a basso allungamento a rottura o a ridotta resistenza meccanica. Cause: microcavità, sollecitazioni meccaniche, termiche (surriscaldamenti locali, temperature elevate) e chimiche (solventi, vapori, gas corrosivi); tensioni interne da raffreddamento irregolare, condizioni di flusso severe, espansione del manufatto sovra-impaccato in cavità che fessura lo strato esterno all'estrazione. Le fessurazioni possono comparire anche settimane dopo la produzione, specialmente in presenza di solventi, soluzioni alcaline o grassi.",
     "description_en": "A tendency to crack, typical of thermoplastics with low elongation at break or reduced mechanical strength — from microvoids, mechanical/thermal/chemical stress, or internal stresses from irregular cooling. Cracks can appear even weeks after production, especially with solvent exposure.",
     "standard_solutions": [
         "Migliorare la qualità del fuso",
         "Limitare la temperatura della massa",
         "Ridurre la velocità d'iniezione",
         "Ridurre la pressione d'iniezione",
         "Ottimizzare i valori e i tempi di Post-pressione",
         "Verificare la sezione del punto d'iniezione per ridurre eventuali surriscaldamenti",
         "(Incrinature biancastre con forti deformazioni durante l'uso) ridurre le sollecitazioni meccaniche, eseguendo piegature di cerniera a caldo o dopo condizionamento",
         "(Manufatto sovra-impaccato) anticipare la commutazione per evitare il picco di pressione",
         "(Manufatto sovra-impaccato) ridurre il valore della Post-pressione 1",
         "(Manufatto sovra-impaccato) ridurre la temperatura d'estrazione, aumentando il tempo di raffreddamento",
         "(Materiale semi-cristallino) ottimizzare la temperatura dello stampo, assicurando uniformità ed equilibrio, e la temperatura della massa",
         "(Materiale semi-cristallino) ridurre la Post-pressione 1 e aumentare la velocità d'iniezione",
         "(Materiale semi-cristallino) assicurare un riempimento di cavità uniforme; valutare una modifica della geometria del manufatto",
         "(Materiale amorfo) ottimizzare la temperatura dello stampo e della massa, ridurre la Post-pressione 1",
         "(Materiale amorfo) aumentare la velocità d'iniezione (se il pezzo non è impaccato) e ridurre il tempo di raffreddamento",
         "Se possibile, usare un materiale semi-cristallino (resiste meglio alle tensioni) o ad alto peso molecolare",
     ]},
    {"code": "F1.8", "name_it": "Pezzo fragile", "name_en": "Brittle part",
     "category": "Difetti funzionali",
     "description_it": "Difetto funzionale grave che riduce la resistenza all'urto. Cause multiple: forma del pezzo, caratteristiche del materiale, pre-essiccazione insufficiente (umidità), presenza di macinato o contaminazione, qualità del fuso e materiale degradato/bruciato/ossidato, orientamento molecolare, tensioni interne, porosità e linee di giunzione, temperatura dello stampo troppo bassa, sollecitazioni generate nel pezzo durante l'estrazione.",
     "description_en": "A serious functional defect that reduces impact resistance, with many possible causes: part geometry, material properties, insufficient drying, regrind or contamination, degraded melt, molecular orientation, internal stresses, porosity, weld lines, low mold temperature, or ejection stress.",
     "standard_solutions": [
         "Verificare la pre-essiccazione del materiale per ridurre l'umidità (aumentarne il tempo se serve)",
         "Verificare che la percentuale di macinato non sia eccessiva",
         "Verificare che non vi sia materiale misto o contaminato nel cilindro",
         "Verificare la velocità di rotazione vite (se possibile, ridurla)",
         "Aumentare la temperatura del cilindro di plastificazione",
         "Verificare la contropressione (diminuirla se possibile)",
         "Verificare il risucchio post-trafila (se utilizzato)",
         "Ridurre la velocità d'iniezione",
         "Ridurre o eliminare il picco di pressione d'iniezione",
         "Verificare se si può ridurre la pressione di mantenimento PP1",
         "Verificare se si può ridurre il TMP",
         "Verificare se si può ridurre la pressione di mantenimento PP2",
         "Ridurre, se possibile, il cuscinetto di materiale",
         "Aumentare la temperatura dello stampo",
         "Ridurre la velocità iniziale di apertura stampo",
         "Usare sostanze distaccanti",
         "Lucidare la sede della materozza, i canali e i punti d'ingresso del materiale nell'impronta",
         "Aumentare la sezione del punto d'iniezione dell'impronta",
         "Lucidare lo stampo, arrotondare gli spigoli",
     ]},

    # =====================================================================
    # 11.6 DIFETTI ESTETICI: Estrazione
    # =====================================================================
    {"code": "E2.1", "name_it": "Pezzo tendente a incollarsi allo stampo", "name_en": "Part sticking to the mold",
     "category": "Difetti estetici — Estrazione",
     "description_it": "In fase di estrazione si formano macchie opache o incavi lucidi a forma di dita o a quadrifoglio sulla superficie del manufatto, generalmente nell'area vicina al punto d'iniezione.",
     "description_en": "During ejection, dull marks or glossy finger- or clover-shaped indentations appear on the surface, usually near the gate.",
     "standard_solutions": [
         "Ridurre la temperatura di stampaggio e il relativo profilo",
         "Ridurre la velocità d'iniezione",
         "Ridurre il picco di pressione",
         "Ridurre il valore di Post-pressione 1",
         "Verificare se si può ridurre il valore di TMP (materiali amorfi)",
         "Verificare se si può ridurre il valore di Post-pressione 2 (materiali amorfi)",
         "Ridurre la temperatura dello stampo",
         "Usare sostanze distaccanti",
         "Lucidare, sformare e arrotondare gli spigoli delle figure interessate",
     ]},
    {"code": "E2.2", "name_it": "Pezzo con segni di materozza", "name_en": "Sprue mark defects",
     "category": "Difetti estetici — Estrazione",
     "description_it": "Il materiale che riveste esternamente la materozza è quello che esce per primo dall'ugello nel riempimento. Segni ricorrenti: materozza con materiale bruciato (temperatura di stampaggio/ugello troppo elevata, velocità d'iniezione alta, diametro ugello troppo piccolo); con segni di giunzione (temperatura di stampaggio bassa); con porosità accentuata (risucchio post-trafila eccessivo che ingloba aria); con segni di risucchio (post-pressione breve o bassa); con bave nella zona di giunzione ai canali (pressioni d'iniezione troppo elevate); con particelle pellicolari che si staccano (impurità o materiali non compatibili col granulato); con striature ad arco (umidità nel granulato); con difficoltà di estrazione (materozza compressa da pressioni elevate, causata da punto d'iniezione troppo piccolo o freddo, post-pressione troppo elevata o lunga, temperatura dello stampo troppo bassa).",
     "description_en": "The sprue's outer skin is the first material out of the nozzle, so its defects reveal upstream problems: burnt material, weld marks, porosity, sink marks, flash, flaking, arc streaks, or extraction difficulty — each pointing to a different process cause.",
     "standard_solutions": [
         "Ridurre l'umidità del materiale in alimentazione",
         "Aumentare la temperatura di stampaggio",
         "Ridurre la velocità d'iniezione",
         "Ridurre la pressione di iniezione",
         "Ridurre il tempo di post-pressione",
         "Aumentare la temperatura dello stampo",
         "Aumentare la sezione del punto d'iniezione",
     ]},
    {"code": "E2.3", "name_it": "Pezzo con segni di estrazione", "name_en": "Ejector marks",
     "category": "Difetti estetici — Estrazione",
     "description_it": "Ispessimenti o avvallamenti circolari dove appoggiano le aste di estrazione, con disomogeneità superficiale nella zona. Quattro tipi di cause: di processo (estrazione prematura, velocità/pressione di estrazione eccessive, posizione finale estrattore troppo avanzata, postpressione elevata, temperatura stampo bassa, diversità dei ritiri); geometriche (accoppiamento sbagliato o lunghezza aste non adeguata); meccaniche (errata conformazione/dimensionamento di stampo, manufatto o sistema di estrazione); termiche (elevata differenza di temperatura tra estrattore e cavità, che causa ritiri in prossimità del punto di estrazione).",
     "description_en": "Circular thickening or sinking where ejector pins press against the part. Four cause families: process (premature ejection, excess ejection speed/pressure), geometric (mismatched or wrong-length pins), mechanical (poor mold/part/ejection design), or thermal (temperature difference between pin and cavity).",
     "standard_solutions": [
         "(Estrazione prematura) prolungare il tempo di raffreddamento; per materiali amorfi verificare che il raffreddamento avvenga a volume costante",
         "(Differenza di lucentezza) eliminare il picco di pressione alla commutazione e ottimizzarne i parametri",
         "(Differenza di lucentezza) ridurre pressione e tempo di mantenimento (PP1, TMP)",
         "(Differenza di lucentezza) uniformare la temperatura in cavità stampo e verificare l'ottimizzazione del ciclo di estrazione",
         "(Deformazione elevata del manufatto) eliminare il picco di pressione alla commutazione, ottimizzarne i parametri, ridurre PP1",
         "(Deformazione elevata del manufatto) migliorare la rigidità dello stampo",
         "(Pressione di estrazione elevata) ridurre PP1, aumentare il tempo di raffreddamento",
         "(Pressione di estrazione elevata) verificare (amorfo) che il raffreddamento avvenga a volume costante; migliorare il raffreddamento delle aste di estrazione",
         "(Pressione di estrazione elevata) controllare la conicità d'estrazione e i sottosquadra",
         "(Pressione di estrazione normale ma segni presenti) ridurre pressione e tempo di mantenimento e la temperatura dello stampo",
     ]},
    {"code": "E2.4", "name_it": "Pezzo con deformazioni in estrazione", "name_en": "Ejection-induced distortion",
     "category": "Difetti estetici — Estrazione",
     "description_it": "Due tipologie: danni causati dall'apertura dello stampo (rotture, deformazioni per allungamento, fessurazioni) e penetrazione degli estrattori nel manufatto (il pezzo non viene estratto e le aste lo deformano o lo penetrano). Causa: la forza di estrazione non riesce a espellere il pezzo senza rovinarlo o deformarlo, oppure il movimento di estrazione è disturbato dalla geometria del manufatto.",
     "description_en": "Two failure modes: damage from mold opening, or ejector pins deforming/penetrating a part that resists release — because ejection force can't free the part cleanly given its geometry.",
     "standard_solutions": [
         "(Pezzo estratto sotto la spinta della pressione residua) anticipare la commutazione in postpressione, ridurre la pressione di mantenimento",
         "(Pezzo estratto sotto la spinta della pressione residua) prolungare il tempo di raffreddamento e aumentare la rigidità dello stampo",
         "(Estrattori che sfondano il pezzo) verificare (amorfo) che il mantenimento sia a volume costante",
         "(Estrattori che sfondano il pezzo) verificare la corretta programmazione del ciclo dell'estrattore e prolungare il raffreddamento",
         "(Deformazione da sottosquadri) ridurre il tempo di raffreddamento e controllare il sistema di estrazione",
         "(Segni di estrazione presenti) ottimizzare tempo di raffreddamento, pressione di mantenimento e TMP",
         "(Forza di estrazione elevata da ritiro sul punzone) ridurre pressione e tempo di mantenimento, prolungare il raffreddamento, controllare conicità d'estrazione e sottosquadra",
         "(Pezzo con molte nervature) ridurre temperatura stampo e velocità di estrazione, controllare lo sfogo-gas del punzone",
         "(Pezzo con molte nervature) impiegare sostanze distaccanti, controllare conicità e sistema di estrazione",
     ]},

    # =====================================================================
    # 11.7 DIFETTI ESTETICI: Corpo del pezzo
    # =====================================================================
    {"code": "E3.1", "name_it": "Pezzo con linee di giunzione marcate e deboli", "name_en": "Weld lines (strong or weak)",
     "category": "Difetti estetici — Corpo del pezzo",
     "description_it": "Le linee di giunzione si formano quando il materiale, seguendo diversi canali di flusso in cavità, si ricongiunge in un unico pezzo. Cause: insufficiente pre-essiccazione o eccessiva contaminazione del materiale; materiale non correttamente plastificato; iniezione troppo lenta o con pressione inadeguata; stampo troppo freddo; punti d'iniezione erroneamente collocati; sfoghi d'aria mancanti o non funzionanti in prossimità delle linee di giunzione.",
     "description_en": "Weld lines form where separate flow fronts rejoin inside the cavity. Caused by poor drying/contamination, under-plasticated material, too-slow injection, a cold mold, badly placed gates, or missing/blocked air vents at the weld.",
     "standard_solutions": [
         "Se possibile, aumentare la pre-essicazione del materiale, o ridurla se eccessiva",
         "Verificare la contaminazione del materiale",
         "Verificare se si può aumentare la velocità della vite",
         "Verificare il profilo di temperatura e, se possibile, aumentarlo",
         "Verificare la correttezza della quota di risucchio post-trafila",
         "Aumentare la velocità d'iniezione",
         "Aumentare la pressione d'iniezione",
         "Aumentare la temperatura dello stampo, in particolare nella zona delle linee di giunzione",
         "Impiegare pigmenti sferici, a granulometria più fine",
         "Impiegare materiale di colore chiaro",
         "Aumentare la superficie del punto d'iniezione o introdurre altri punti d'iniezione",
         "Spostare il punto d'iniezione",
         "Effettuare degli sfoghi d'aria in corrispondenza del difetto",
     ]},
    {"code": "E3.2", "name_it": "Pezzo con goccia fredda o giunzione fredda", "name_en": "Cold slug / cold weld",
     "category": "Difetti estetici — Corpo del pezzo",
     "description_it": "Se nei canali di alimentazione, nella materozza o nell'ugello si trova materiale raffreddato che, spinto in cavità, non fonde durante lo scorrimento, si può posizionare in un punto qualsiasi dell'impronta (goccia fredda) oppure causare la separazione parziale del flusso, ostruendo i passaggi (giunzioni fredde). Cause: errata temperatura dell'ugello; diametro ugello troppo piccolo; risucchio post-trafila basso; tempo di raffreddamento inferiore al tempo di dosaggio.",
     "description_en": "Cooled material sitting in the runners, sprue or nozzle gets pushed into the cavity without re-melting, appearing as a cold slug or causing a cold weld line. Caused by wrong nozzle temperature, too-small nozzle bore, low decompression, or cooling time shorter than dosing time.",
     "standard_solutions": [
         "Diminuire l'eventuale raffreddamento della boccola d'iniezione",
         "Ottimizzare la temperatura dell'ugello",
         "Verificare che il tempo di raffreddamento copra la carica materiale",
         "Verificare la correttezza della quota stop risucchio post-trafila",
         "Aumentare il diametro del foro dell'ugello",
         "Verificare il corretto funzionamento dell'ugello",
         "Impiegare la valvola sull'ugello, se il materiale lo permette",
     ]},
    {"code": "E3.3", "name_it": "Pezzo con avvallamenti o risucchi", "name_en": "Sink marks",
     "category": "Difetti estetici — Corpo del pezzo",
     "description_it": "Avvallamenti o risucchi sulla superficie, generalmente in corrispondenza di nervature o spessori consistenti, dove un impaccamento adeguato non riesce a compensare la contrazione della massa. Cause: dose insufficiente; canali troppo stretti (raffreddamento precoce della massa); temperature del fuso eccessive; qualità del fuso scadente; valori e tempi di post-pressione insufficienti; temperatura dello stampo troppo bassa; sezioni del punto d'iniezione troppo strette.",
     "description_en": "Surface depressions, usually over ribs or thick sections, where packing can't fully compensate for material shrinkage. Caused by short shot dosing, restrictive runners, excess melt temperature, poor melt quality, insufficient holding, cold mold, or a too-narrow gate.",
     "standard_solutions": [
         "(Cuscinetto insufficiente) aumentare la quota di stop carica materiale",
         "(Cuscinetto insufficiente) aumentare la contropressione se la qualità del fuso non è adeguata",
         "(Cuscinetto insufficiente) verificare la tenuta dell'anello della valvola di non ritorno",
         "(Risucchi su pareti spesse o vicino al punto d'iniezione) ridurre, se possibile, temperatura di stampaggio e velocità d'iniezione",
         "(Risucchi su pareti spesse o vicino al punto d'iniezione) aumentare la Post-pressione 1 e il suo tempo; ottimizzare il tempo di Post-pressione 2 (amorfi)",
         "(Risucchi su pareti spesse o vicino al punto d'iniezione) ridurre la temperatura dello stampo",
         "(Risucchi su pareti sottili o lontane dal punto d'iniezione) ottimizzare il tempo di postpressione 1",
         "(Risucchi su pareti sottili o lontane dal punto d'iniezione) ridurre la quota di commutazione, o ritardarne l'intervento",
         "(Risucchi su pareti sottili o lontane dal punto d'iniezione) aumentare temperatura di stampaggio, temperatura dell'impronta e velocità d'iniezione",
         "(Risucchi che compaiono dopo l'estrazione) controllare gli sfoghi d'aria dello stampo e ottimizzare la temperatura dello stampo",
         "(Risucchi che compaiono dopo l'estrazione) controllare umidità e granulometria del materiale",
         "(Risucchi che compaiono dopo l'estrazione) valutare additivi espandenti o un materiale con ritiro di stampaggio inferiore",
         "(Risucchi che compaiono dopo l'estrazione) controllare la sezione dei canali di alimentazione e del punto d'iniezione",
     ]},
    {"code": "E3.4", "name_it": "Pezzo con sfogliature, sfaldamenti o delaminazioni", "name_en": "Flaking / delamination",
     "category": "Difetti estetici — Corpo del pezzo",
     "description_it": "Formazione sul pezzo di sottili strati o lamelle che tendono a staccarsi dalla superficie del manufatto. Cause: velocità d'iniezione troppo elevate; temperature del fuso troppo alte; disomogeneità della massa per cattiva plastificazione, per inquinamento da materiali estranei/sporcizia, per incompatibilità di additivi/coloranti/masterbatch, o per umidità eccessiva.",
     "description_en": "Thin layers or flakes form and peel from the part's surface — caused by excess injection speed or melt temperature, or a non-homogeneous melt from poor plastication, contamination, incompatible additives, or excess moisture.",
     "standard_solutions": [
         "(Dopo un cambio di coloranti) verificare eventuale contaminazione e inquinamento del granulato",
         "(Dopo un cambio di coloranti) controllare la compatibilità degli additivi coloranti e l'umidità del granulato",
         "(Dopo un cambio di coloranti) controllare l'omogeneità del fuso e la qualità della plastificazione",
         "(Dopo un cambio di coloranti) aumentare la temperatura dello stampo",
         "(In condizioni normali di stampaggio) ridurre la velocità d'iniezione e la temperatura di stampaggio",
         "(In condizioni normali di stampaggio) aumentare la temperatura dello stampo",
     ]},
    {"code": "E3.5", "name_it": "Pezzo con effetto rughe", "name_en": "Ripple / wrinkle effect",
     "category": "Difetti estetici — Corpo del pezzo",
     "description_it": "Superficie rugosa, simile a solchi di un disco: concentrici in caso di iniezioni capillari, oppure che seguono il fronte del flusso in caso di iniezioni laminari o laterali. Causa: temperatura dello stampo troppo bassa, che fa solidificare lo strato a contatto con le pareti metalliche formando una crosta fredda sollecitata ciclicamente durante il riempimento.",
     "description_en": "A rippled, record-groove-like surface — caused by a mold too cold, which freezes a skin against the cavity wall that gets cyclically disturbed during filling.",
     "standard_solutions": [
         "Aumentare la temperatura dello stampo",
         "Aumentare la velocità d'iniezione",
         "Aumentare la temperatura di stampaggio",
         "Adeguare, se possibile, la geometria dei canali",
     ]},
    {"code": "E3.6", "name_it": "Pezzo con effetto \"diesel\" (bruciature)", "name_en": "\"Diesel\" effect / burn marks",
     "category": "Difetti estetici — Corpo del pezzo",
     "description_it": "Bruciature sulla superficie, talvolta con riempimento incompleto, in prossimità di fori ciechi, nervature, zone di fine percorso del flusso o dove più fronti si saldano. Causa: l'aria che non riesce a uscire dalla cavità viene compressa e surriscaldata fino a causare la degradazione termica del materiale, con emissione di prodotti di combustione aggressivi che danneggiano la superficie della cavità dello stampo.",
     "description_en": "Burn marks, sometimes with a short shot, near blind holes, ribs, flow-end zones, or where fronts meet. Trapped air compresses and overheats until the material thermally degrades, releasing aggressive combustion by-products that can also corrode the mold surface.",
     "standard_solutions": [
         "Ridurre la forza di chiusura dello stampo",
         "Ridurre la velocità d'iniezione",
         "Modificare il profilo di velocità del riempimento",
         "Controllare gli sfoghi d'aria (intasati, sporcizia, fumi)",
         "Prevedere sfoghi d'aria dove compaiono le bruciature",
     ]},
    {"code": "E3.7", "name_it": "Pezzo con formazione di bolle d'aria", "name_en": "Air bubbles / voids",
     "category": "Difetti estetici — Corpo del pezzo",
     "description_it": "La massa fusa ingloba aria durante lo stampaggio: si manifesta con avvallamenti superficiali e, nei materiali trasparenti, con bolle d'aria intrappolate visibili nel corpo del pezzo. Cause: velocità o quota di risucchio post-trafila eccessive; cariche eccessive con qualità finale scadente; inglobamento da più flussi. Con materiali opachi il difetto è difficile da distinguere dagli avvallamenti/risucchi: si riconosce perché variando PP1/TMP non si riduce il difetto, si riduce togliendo il risucchio, e immergendo il pezzo in acqua e forandolo in corrispondenza delle bolle si sviluppano bollicine gassose.",
     "description_en": "The melt traps air during molding — visible as surface depressions, or in clear materials as visible internal bubbles. Diagnostic trick with opaque parts: unlike sink marks, this defect doesn't respond to PP1/TMP changes, improves when decompression is reduced, and releases gas bubbles when the part is punctured underwater.",
     "standard_solutions": [
         "Ridurre la velocità e la quota del risucchio",
         "Aumentare, se possibile, la velocità di rotazione vite",
         "Aumentare la contropressione per una migliore eliminazione dell'aria",
         "Controllare l'alimentazione in tramoggia",
         "Controllare l'unità d'iniezione",
     ]},

    # =====================================================================
    # 11.8 DIFETTI ESTETICI: Superficie del pezzo
    # =====================================================================
    {"code": "E4.1", "name_it": "Superfici con puntinature scure, nere, lucenti e impurità", "name_en": "Black specks / dark spots / impurities",
     "category": "Difetti estetici — Superficie",
     "description_it": "Puntinature scure (nere, di dimensioni inferiori a 1 mm fino a microscopiche) oppure puntinature più grandi, opache o riflettenti la luce. Cause: degradazione termica del fuso per alte temperature del fuso/vite o tempo di permanenza prolungato nel cilindro; usura delle parti metalliche (vite, valvola, tramoggia, condotte di alimentazione); impurità sul polimero o additivi esterni (inquinamento, alta percentuale di macinato, colorante o masterbatch inappropriato).",
     "description_en": "Dark specks (from sub-millimeter to microscopic) or larger dull/glossy spots. Caused by thermal degradation from overheating or excess residence time, worn metal parts, or contamination from external impurities, regrind, colorant or masterbatch.",
     "standard_solutions": [
         "(Materiale inquinato) non usare tubi/contenitori/tramogge di alluminio o banda stagnata: usare acciaio o equivalente, minimizzando gli angoli di rinvio nei percorsi di trasporto",
         "(Materiale inquinato) mantenere pulito l'essiccatore e il filtro dell'aria; scartare manufatti umidi o danneggiati termicamente",
         "(Materiale inquinato) separare tra loro le diverse materie plastiche; non essiccarle mai insieme; immagazzinarle separatamente",
         "(Materiale inquinato) controllare i mulini per evitare le conseguenze dell'usura; immagazzinare gli scarti al riparo dalle polveri",
         "(Materiale inquinato) pulire i manufatti sporchi prima della macinazione; chiudere con cura sacchi rotti e contenitori",
         "(Materiale inquinato) pulire l'unità di plastificazione prima di cambiare materiale",
         "(Materiale inquinato) verificare eventuale usura o corrosione di vite/valvola e la presenza di punti di ristagno",
         "(Materiale inquinato) controllare i canali di alimentazione per eventuali impurità",
         "(Temperatura della massa troppo elevata) diminuire la velocità di rotazione della vite",
         "(Temperatura della massa troppo elevata) ridurre temperatura di stampaggio, contropressione e velocità d'iniezione",
         "(Temperatura della massa troppo elevata) controllare la temperatura dei canali caldi",
         "(Tempo di permanenza nel cilindro elevato) calcolare il tempo di permanenza e confrontarlo col massimo consentito dal materiale: se molto eccessivo usare una vite più piccola, se di poco ridurre velocità vite o tempo di ciclo",
         "(Tempo di permanenza nel cilindro elevato) ridurre la percentuale di macinato e controllare l'idoneità degli additivi",
     ]},
    {"code": "E4.2", "name_it": "Superfici disomogenee (opacità, ombre, lucentezza)", "name_en": "Uneven gloss / cloudiness / shadowing",
     "category": "Difetti estetici — Superficie",
     "description_it": "La lucentezza e l'uniformità della superficie dipendono dalla capacità di riflettere la luce incidente: a parità di colorazione, l'intensità riflessa diminuisce con l'aumentare della rugosità. Cause: grado di finitura della superficie dello stampo; raffreddamento non uniforme della massa a contatto con lo stampo; contrazioni differenziate (ritiri) del materiale; sollecitazioni meccaniche sulle diverse parti del pezzo; deformazioni eccessive su certe parti del manufatto.",
     "description_en": "Surface gloss and uniformity depend on how the surface reflects incident light — reflected intensity falls as roughness rises. Caused by mold finish, uneven cooling, differential shrinkage, mechanical stress, or localized deformation.",
     "standard_solutions": [
         "(Superfici uniformemente opache, stampo lucido) aumentare temperatura stampo, temperatura di stampaggio e velocità d'iniezione; migliorare la lucidatura della cavità stampo",
         "(Superfici uniformemente opache, stampo satinato) ridurre temperatura stampo, temperatura di stampaggio e velocità d'iniezione; ridurre il grado di rugosità dello stampo",
         "(Brillantezza variabile su superfici lucide) ottimizzare velocità vite e profilo di temperature del cilindro; ridurre il cuscinetto e aumentare la contropressione",
         "(Brillantezza variabile su superfici lucide) aumentare temperatura ugello e postpressione; controllare l'unità di plastificazione e lucidare uniformemente le cavità",
         "(Vicino a estrattori o tasselli mobili) ottimizzare il punto di commutazione per eliminare il picco di pressione; ridurre postpressione e TMP",
         "(Vicino a estrattori o tasselli mobili) uniformare la temperatura in cavità stampo; cambiare il sistema o la geometria delle spine estrattrici",
         "(In corrispondenza di fori) adattare la geometria dei fori o spostare il punto d'iniezione",
         "(In corrispondenza di linee di giunzione) aumentare temperatura cavità e velocità d'iniezione, spostare il punto d'iniezione",
         "(In prossimità degli angoli) uniformare la temperatura con canali di raffreddamento supplementari negli angoli; arrotondare gli angoli",
         "(In corrispondenza di nervature) aumentare/ottimizzare la postpressione (PP1, TMP); migliorare la geometria del manufatto e il raffreddamento",
         "(In funzione della variazione di spessore) aumentare/ottimizzare la postpressione e il profilo di velocità di riempimento",
         "(Anche su spessori costanti) impiegare un materiale d'altro colore; ridurre la percentuale dell'additivo rinforzante (fibre di vetro)",
     ]},
    {"code": "E4.3", "name_it": "Superfici con effetti buccia d'arancia", "name_en": "Orange-peel surface",
     "category": "Difetti estetici — Superficie",
     "description_it": "Superfici non lisce e non uniformi, con increspature e rugosità che ricordano la buccia d'arancia. Cause: flusso di riempimento troppo lento; temperature di stampaggio e dello stampo troppo basse.",
     "description_en": "A rough, non-uniform surface texture resembling orange peel — caused by too-slow filling flow and mold/melt temperatures set too low.",
     "standard_solutions": [
         "Aumentare la temperatura di stampaggio",
         "Aumentare la velocità d'iniezione",
         "Aumentare la pressione d'iniezione",
         "Aumentare la temperatura dello stampo",
     ]},
    {"code": "E4.4", "name_it": "Superfici con opacità e macchie al punto d'iniezione", "name_en": "Gate blush / haze around the gate",
     "category": "Difetti estetici — Superficie",
     "description_it": "Zone opache intorno al punto d'iniezione. Cause: sezioni d'iniezione strette (capillari o sottomarine); velocità d'iniezione elevate. L'alta velocità nel punto d'iniezione sottopone il materiale a uno sforzo di taglio che surriscalda gli strati e provoca un forte orientamento molecolare, con micro-fessurazioni che danno l'aspetto opaco.",
     "description_en": "Hazy patches around the gate — from narrow gates (capillary/submarine) combined with high injection speed, which shears and overheats the material and drives molecular orientation, producing micro-cracks that read as dullness.",
     "standard_solutions": [
         "Ridurre la velocità d'iniezione, oppure adottare un profilo lento-veloce",
         "Aumentare la temperatura di stampaggio, per migliorare la fluidità della massa",
         "Arrotondare gli spigoli vivi del punto d'iniezione",
         "Aumentare la sezione del punto d'iniezione",
     ]},
    {"code": "E4.5", "name_it": "Superfici del pezzo con effetti getto libero (jetting)", "name_en": "Jetting",
     "category": "Difetti estetici — Superficie",
     "description_it": "Serpentina ruvida e opaca sulla superficie, con variazioni di aspetto o colore (in certi casi chiamata anche effetto rughe). Causa: bruschi aumenti di spessore o alte velocità d'iniezione che proiettano il materiale nell'impronta a forma di \"getto libero\" invece che con un fronte di avanzamento che riempie tutta la sezione di passaggio.",
     "description_en": "A rough, dull, snake-like trail on the surface with visible texture or color variation. Caused by sudden thickness jumps or high injection speed that shoots material as a free jet instead of a proper advancing flow front.",
     "standard_solutions": [
         "Ridurre la velocità d'iniezione, oppure impostare profili lento-veloce",
         "Aumentare la temperatura di stampaggio",
         "Arrotondare gli spigoli in prossimità del punto d'iniezione",
         "Ingrandire la sezione del punto d'iniezione",
         "Cambiare la posizione del punto d'iniezione",
         "Collocare nella cavità, di fronte al punto d'iniezione, un inserto con funzione di frangi-flusso",
     ]},

    # =====================================================================
    # 11.9 DIFETTI ESTETICI: Venature-striature superficiali del pezzo
    # =====================================================================
    {"code": "E5.1", "name_it": "Superfici con venature da degradazione (brune argentee)", "name_en": "Degradation streaks (brown / silver)",
     "category": "Difetti estetici — Venature",
     "description_it": "Venature brune, brunastre o argentee. Le brune sono dovute a degradazione termica; le brunastre a degradazione chimica; le argentee a fenomeni fisici come la rottura delle macromolecole. Degradazione termica: temperature o tempo di essiccazione troppo elevati, temperatura della massa troppo elevata, sforzo di taglio eccessivo della vite o al punto d'iniezione. Degradazione chimica: temperatura di stampaggio troppo elevata, tempo di permanenza nel cilindro oltre il massimo, punti di ristagno/angoli morti/usura-corrosione di vite-cilindro-valvola, temperatura eccessiva in uno o più canali caldi.",
     "description_en": "Brown, brownish or silvery streaks — thermal degradation (brown), chemical degradation (brownish), or physical macromolecule breakdown (silver). Root causes span drying, melt overheating, excessive shear, stagnation points, worn screw/barrel/valve, or hot-runner overheating.",
     "standard_solutions": [
         "(Temperatura di stampaggio oltre il massimo) verificare la temperatura del fuso con spurgo e pirometro, e ridurla se necessario",
         "(Temperatura di stampaggio oltre il massimo) ottimizzare velocità vite, profilo di temperatura del cilindro, controlli termici delle zone e contropressione",
         "(Tempo di permanenza nel cilindro oltre il massimo) se molto superato usare un diametro vite inferiore; se di poco, ridurre velocità vite o tempo di ciclo",
         "(Tempo di permanenza nel cilindro oltre il massimo) ridurre la percentuale di macinato; controllare il controllo termico del canale caldo, se presente",
         "(Venature dopo lo scarico del cilindro) controllare cilindro, vite, valvole di non ritorno e superfici di tenuta per zone di ristagno; controllare usura",
         "(Venature dopo lo scarico del cilindro) controllare lo stato dei granuli e la pulizia della tramoggia",
         "(Venature vicino al punto d'iniezione) ridurre la velocità d'iniezione e usare un profilo lento-veloce; verificare spigoli vivi nei canali; controllare i canali caldi",
         "(Venature lontano dal punto d'iniezione) ridurre la velocità d'iniezione; verificare spigoli vivi e spessori troppo sottili nei canali di alimentazione",
         "(Venature lontano dal punto d'iniezione) controllare l'essiccazione del granulato e ridurre la percentuale di macinato",
         "Impiegare materiali e coloranti termicamente più stabili",
     ]},
    {"code": "E5.2", "name_it": "Superfici con striature per affioramento di fibre di vetro", "name_en": "Glass-fiber surfacing streaks",
     "category": "Difetti estetici — Venature",
     "description_it": "I manufatti in materiale rinforzato presentano spesso un affioramento superficiale delle fibre, con striature luccicanti che rendono la superficie ruvida e irregolare. Causa: le fibre di vetro si orientano longitudinalmente lungo il flusso d'iniezione; se il fuso si raffredda troppo velocemente a contatto con la cavità, la fibra non rimane ben inglobata nella massa e tende a uscire verso l'esterno. Il difetto è accentuato dalla differenza di ritiro tra fibra e plastica.",
     "description_en": "Glass-reinforced parts often show fibers surfacing as shiny streaks, roughening the finish. Fibers align along the flow direction, and if the melt freezes too fast against the cavity wall they aren't fully encapsulated and migrate outward — worsened by the shrinkage mismatch between fiber and resin.",
     "standard_solutions": [
         "Aumentare la velocità d'iniezione",
         "Aumentare la temperatura dello stampo",
         "Aumentare la temperatura di stampaggio",
         "Aumentare il valore della Post-pressione 1",
         "Ottimizzare il tempo di mantenimento (TMP)",
         "Impiegare fibre di vetro corte",
         "Spostare il punto d'iniezione per posizionare la linea di giunzione in una zona non visibile della superficie",
     ]},
    {"code": "E5.3", "name_it": "Superfici del pezzo con striature da umidità", "name_en": "Moisture streaks",
     "category": "Difetti estetici — Venature",
     "description_it": "Striature argentee circondate da aree porose. Cause: umidità presente nello stampo o nella massa di materiale, che può provenire da condensazione sulle pareti delle cavità, perdita d'acqua dai canali di raffreddamento dello stampo, errato stoccaggio del materiale o insufficiente essiccazione.",
     "description_en": "Silvery streaks surrounded by porous patches — from moisture in the mold or the material, whether from condensation, a leaking cooling channel, poor material storage, or insufficient drying.",
     "standard_solutions": [
         "Aumentare la temperatura dello stampo",
         "Controllare l'ermeticità dei canali di raffreddamento dello stampo",
         "Verificare l'imballaggio del materiale",
         "Verificare lo stoccaggio del materiale (granulo)",
         "Essiccare sufficientemente il materiale",
         "Ridurre il tempo di permanenza del granulo nella tramoggia",
     ]},
    {"code": "E5.4", "name_it": "Superfici con striature da aria inglobata", "name_en": "Trapped-air streaks",
     "category": "Difetti estetici — Venature",
     "description_it": "Sfiammature opache o argentee, localizzate soprattutto vicino al punto d'iniezione o in corrispondenza di variazioni di spessore, nervature, asole o lettere incise. Causa: aria presente in cavità non completamente espulsa, che resta inglobata nella massa fusa, estendendosi nella direzione del flusso. In prossimità di incisioni/nervature/incavi, la massa fusa può superare la piccola massa d'aria formando striature a forma di U dette \"effetto uncino\".",
     "description_en": "Dull or silvery streaks near the gate or at thickness changes, ribs, slots or engraved lettering — from air trapped in the melt that wasn't fully vented, sometimes forming a U-shaped \"hook\" streak near a geometric feature.",
     "standard_solutions": [
         "(Con effetto uncino) ridurre la velocità d'iniezione, eliminare gli spigoli vivi nelle variazioni di spessore",
         "(Con effetto uncino) ridurre la profondità delle incisioni eventualmente presenti",
         "(Vicino al punto d'iniezione) ridurre velocità e quota di risucchio; impiegare ugello con otturatore",
         "(Lontano dal punto d'iniezione) ridurre la velocità d'iniezione e aumentare la contropressione",
         "(Lontano dal punto d'iniezione) verificare la tenuta dell'accoppiamento ugello-stampo",
         "(Lontano dal punto d'iniezione) ridurre gli spigoli vivi e spostare il punto d'iniezione",
     ]},
    {"code": "E5.5", "name_it": "Superfici con venature di colore", "name_en": "Color streaks",
     "category": "Difetti estetici — Venature",
     "description_it": "Venature, alterazioni, viraggio e degradazione del colore. Cause: cattiva dispersione dei coloranti o loro miscelazione durante l'iniezione; temperatura del fuso troppo elevata; incompatibilità dei coloranti con le resine termoplastiche. I master e i pigmenti possono degradare termicamente con temperature o tempi di permanenza nel cilindro troppo prolungati.",
     "description_en": "Color streaking, shift or degradation — from poor colorant dispersion or mixing, excess melt temperature, or colorant/resin incompatibility; masterbatches and pigments can also thermally degrade with excess heat or residence time.",
     "standard_solutions": [
         "Ottimizzare la velocità di rotazione vite",
         "Aumentare la contropressione",
         "Aumentare la velocità d'iniezione",
         "Ridurre la sezione del punto (o dei punti) d'iniezione",
         "Usare masterbatch o pigmenti in pasta con fluidità compatibile col materiale",
         "Usare prodotti coloranti a granulo fine",
         "Controllare la solubilità del prodotto colorante",
         "Usare un materiale con una granulometria più fine",
         "Se non si può modificare la granulometria: usare una vite con L/D più elevato, elementi miscelanti tra vite e ugello, o valvole di non ritorno speciali",
     ]},
]

# Database materiali completo (43 materiali) — integrato da CycleTime Pro con proprietà da vademecum
_RAW_MATS = {
 'ABS tutti tipi':{'tipo':'A','family':'ABS','dsol':1.04,'dliq':0.88,'ddiff':15,'ritLong':0.4,'ritTrsv':0.7,'taMin':240,'taCons':240,'taMax':250,'tsMin':50,'tspo':70,'tsMax':80,'testr':95,'pp1min':350,'pp1max':550,'vper':0.3,'vperReale':0.42,'velAf':24,'vcrist':None,'dTp':30,'tingrVite':80,'pressEssTem':90,'pressEssTpo':2,'macMax':30,'calorePlast':100,'tpmv':5,'denA':1.3},
 'ABS rit. fiam.':{'tipo':'A','family':'ABS','dsol':1.04,'dliq':0.88,'ddiff':15,'ritLong':0.4,'ritTrsv':0.7,'taMin':220,'taCons':230,'taMax':240,'tsMin':49,'tspo':70,'tsMax':74,'testr':95,'pp1min':350,'pp1max':550,'vper':0.3,'vperReale':0.42,'velAf':22,'vcrist':None,'dTp':30,'tingrVite':70,'pressEssTem':90,'pressEssTpo':2,'macMax':30,'calorePlast':100,'tpmv':6,'denA':1.3},
 'ABS visc. bassa':{'tipo':'A','family':'ABS','dsol':1.04,'dliq':0.88,'ddiff':15,'ritLong':0.4,'ritTrsv':0.7,'taMin':200,'taCons':210,'taMax':220,'tsMin':49,'tspo':70,'tsMax':74,'testr':95,'pp1min':350,'pp1max':500,'vper':0.3,'vperReale':0.42,'velAf':20,'vcrist':None,'dTp':30,'tingrVite':70,'pressEssTem':90,'pressEssTpo':2,'macMax':30,'calorePlast':100,'tpmv':7,'denA':1.3},
 'PS':{'tipo':'A','family':'PS','dsol':1.06,'dliq':0.91,'ddiff':14,'ritLong':0.5,'ritTrsv':0.3,'taMin':210,'taCons':220,'taMax':230,'tsMin':20,'tspo':40,'tsMax':50,'testr':80,'pp1min':400,'pp1max':600,'vper':0.6,'vperReale':0.84,'velAf':24,'vcrist':None,'dTp':30,'tingrVite':30,'pressEssTem':70,'pressEssTpo':2,'macMax':30,'calorePlast':100,'tpmv':8,'denA':1.29},
 'HI-PS':{'tipo':'A','family':'PS','dsol':1.08,'dliq':0.91,'ddiff':16,'ritLong':0.5,'ritTrsv':0.5,'taMin':210,'taCons':220,'taMax':230,'tsMin':25,'tspo':40,'tsMax':43,'testr':85,'pp1min':350,'pp1max':550,'vper':0.5,'vperReale':0.7,'velAf':22,'vcrist':None,'dTp':30,'tingrVite':80,'pressEssTem':70,'pressEssTpo':2,'macMax':30,'calorePlast':100,'tpmv':8,'denA':1.26},
 'SAN':{'tipo':'A','family':'SAN','dsol':1.07,'dliq':0.8,'ddiff':25,'ritLong':0.5,'ritTrsv':0.5,'taMin':220,'taCons':240,'taMax':270,'tsMin':49,'tspo':70,'tsMax':74,'testr':85,'pp1min':400,'pp1max':550,'vper':0.3,'vperReale':0.42,'velAf':20,'vcrist':None,'dTp':30,'tingrVite':80,'pressEssTem':80,'pressEssTpo':2,'macMax':30,'calorePlast':100,'tpmv':3.5,'denA':1.28},
 'CA':{'tipo':'A','family':'CA','dsol':1.28,'dliq':1.02,'ddiff':20,'ritLong':0.6,'ritTrsv':0.7,'taMin':190,'taCons':220,'taMax':240,'tsMin':25,'tspo':40,'tsMax':43,'testr':80,'pp1min':350,'pp1max':550,'vper':0.3,'vperReale':0.42,'velAf':20,'vcrist':None,'dTp':30,'tingrVite':80,'pressEssTem':70,'pressEssTpo':2,'macMax':20,'calorePlast':108,'tpmv':8,'denA':1.06},
 'CAB':{'tipo':'A','family':'CAB','dsol':1.18,'dliq':0.97,'ddiff':18,'ritLong':0.5,'ritTrsv':0.6,'taMin':190,'taCons':220,'taMax':240,'tsMin':25,'tspo':40,'tsMax':43,'testr':80,'pp1min':350,'pp1max':550,'vper':0.3,'vperReale':0.42,'velAf':20,'vcrist':None,'dTp':30,'tingrVite':80,'pressEssTem':70,'pressEssTpo':2,'macMax':20,'calorePlast':108,'tpmv':8,'denA':1.1},
 'CP':{'tipo':'A','family':'CP','dsol':1.22,'dliq':1.04,'ddiff':15,'ritLong':0.5,'ritTrsv':0.5,'taMin':210,'taCons':230,'taMax':240,'tsMin':25,'tspo':40,'tsMax':43,'testr':80,'pp1min':350,'pp1max':550,'vper':0.3,'vperReale':0.42,'velAf':20,'vcrist':None,'dTp':30,'tingrVite':80,'pressEssTem':70,'pressEssTpo':2,'macMax':20,'calorePlast':108,'tpmv':8,'denA':1.0},
 'PMMA':{'tipo':'A','family':'PMMA','dsol':1.18,'dliq':0.94,'ddiff':20,'ritLong':0.2,'ritTrsv':0.5,'taMin':220,'taCons':230,'taMax':270,'tsMin':40,'tspo':60,'tsMax':70,'testr':85,'pp1min':350,'pp1max':550,'vper':0.3,'vperReale':0.42,'velAf':25,'vcrist':None,'dTp':30,'tingrVite':90,'pressEssTem':75,'pressEssTpo':3,'macMax':20,'calorePlast':95,'tpmv':6,'denA':1.02},
 'PPO':{'tipo':'A','family':'PPO','dsol':1.06,'dliq':0.94,'ddiff':11,'ritLong':0.6,'ritTrsv':0.8,'taMin':250,'taCons':280,'taMax':300,'tsMin':56,'tspo':80,'tsMax':85,'testr':140,'pp1min':600,'pp1max':770,'vper':0.3,'vperReale':0.42,'velAf':20,'vcrist':None,'dTp':30,'tingrVite':90,'pressEssTem':100,'pressEssTpo':2,'macMax':20,'calorePlast':140,'tpmv':12,'denA':0.87},
 'PPE':{'tipo':'A','family':'PPE','dsol':1.06,'dliq':0.94,'ddiff':11,'ritLong':0.6,'ritTrsv':0.8,'taMin':240,'taCons':280,'taMax':340,'tsMin':56,'tspo':80,'tsMax':85,'testr':128,'pp1min':600,'pp1max':770,'vper':0.3,'vperReale':0.42,'velAf':20,'vcrist':None,'dTp':30,'tingrVite':90,'pressEssTem':100,'pressEssTpo':2,'macMax':20,'calorePlast':150,'tpmv':10,'denA':1.53},
 'PPS Ryton amorfo':{'tipo':'A','family':'PPS','dsol':1.98,'dliq':1.78,'ddiff':10,'ritLong':0.25,'ritTrsv':0.55,'taMin':305,'taCons':330,'taMax':340,'tsMin':63,'tspo':90,'tsMax':95,'testr':204,'pp1min':400,'pp1max':600,'vper':0.5,'vperReale':0.7,'velAf':15,'vcrist':None,'dTp':30,'tingrVite':150,'pressEssTem':150,'pressEssTpo':5,'macMax':20,'calorePlast':160,'tpmv':60,'denA':0.56},
 'PPS':{'tipo':'A','family':'PPS','dsol':1.3,'dliq':1.1,'ddiff':15,'ritLong':0.7,'ritTrsv':0.7,'taMin':320,'taCons':330,'taMax':350,'tsMin':42,'tspo':60,'tsMax':64,'testr':204,'pp1min':300,'pp1max':700,'vper':0.5,'vperReale':0.7,'velAf':22,'vcrist':None,'dTp':30,'tingrVite':110,'pressEssTem':150,'pressEssTpo':6,'macMax':20,'calorePlast':155,'tpmv':60,'denA':1.64},
 'PC':{'tipo':'A','family':'PC','dsol':1.2,'dliq':0.97,'ddiff':19,'ritLong':0.6,'ritTrsv':0.6,'taMin':280,'taCons':290,'taMax':320,'tsMin':70,'tspo':80,'tsMax':100,'testr':105,'pp1min':350,'pp1max':550,'vper':0.3,'vperReale':0.42,'velAf':20,'vcrist':None,'dTp':30,'tingrVite':110,'pressEssTem':120,'pressEssTpo':4,'macMax':20,'calorePlast':108,'tpmv':6,'denA':1.47},
 'TMBRA PC':{'tipo':'A','family':'PC','dsol':1.2,'dliq':0.96,'ddiff':19,'ritLong':0.6,'ritTrsv':0.6,'taMin':280,'taCons':300,'taMax':320,'tsMin':56,'tspo':80,'tsMax':85,'testr':105,'pp1min':350,'pp1max':550,'vper':0.3,'vperReale':0.42,'velAf':20,'vcrist':None,'dTp':30,'tingrVite':110,'pressEssTem':120,'pressEssTpo':4,'macMax':20,'calorePlast':108,'tpmv':6,'denA':1.8},
 'PVC rigido':{'tipo':'A','family':'PVC','dsol':1.34,'dliq':1.12,'ddiff':16,'ritLong':0.4,'ritTrsv':1.5,'taMin':170,'taCons':180,'taMax':190,'tsMin':15,'tspo':30,'tsMax':33,'testr':70,'pp1min':500,'pp1max':700,'vper':0.2,'vperReale':0.28,'velAf':15,'vcrist':None,'dTp':30,'tingrVite':30,'pressEssTem':None,'pressEssTpo':None,'macMax':10,'calorePlast':50,'tpmv':30,'denA':1.3},
 'PVC plastificato':{'tipo':'A','family':'PVC','dsol':1.3,'dliq':1.12,'ddiff':14,'ritLong':0.4,'ritTrsv':1.5,'taMin':170,'taCons':180,'taMax':190,'tsMin':15,'tspo':30,'tsMax':33,'testr':70,'pp1min':350,'pp1max':500,'vper':0.4,'vperReale':0.56,'velAf':20,'vcrist':None,'dTp':30,'tingrVite':30,'pressEssTem':None,'pressEssTpo':None,'macMax':10,'calorePlast':70,'tpmv':30,'denA':0.63},
 'PVC morbido':{'tipo':'A','family':'PVC','dsol':0.9,'dliq':0.8,'ddiff':11,'ritLong':0.4,'ritTrsv':1.5,'taMin':170,'taCons':180,'taMax':190,'tsMin':15,'tspo':30,'tsMax':33,'testr':70,'pp1min':350,'pp1max':500,'vper':0.4,'vperReale':0.56,'velAf':18,'vcrist':None,'dTp':30,'tingrVite':30,'pressEssTem':None,'pressEssTpo':None,'macMax':10,'calorePlast':70,'tpmv':30,'denA':1.8},
 'SEBS':{'tipo':'A','family':'SEBS','dsol':1.0,'dliq':0.96,'ddiff':4,'ritLong':1.2,'ritTrsv':1.4,'taMin':190,'taCons':230,'taMax':250,'tsMin':30,'tspo':45,'tsMax':48,'testr':90,'pp1min':350,'pp1max':500,'vper':0.3,'vperReale':0.42,'velAf':18,'vcrist':None,'dTp':20,'tingrVite':30,'pressEssTem':None,'pressEssTpo':None,'macMax':20,'calorePlast':130,'tpmv':15,'denA':1.2},
 'PA6':{'tipo':'C','family':'PA','dsol':1.14,'dliq':0.91,'ddiff':20,'ritLong':0.8,'ritTrsv':0.8,'taMin':250,'taCons':270,'taMax':280,'tsMin':60,'tspo':90,'tsMax':100,'testr':130,'pp1min':500,'pp1max':700,'vper':0.5,'vperReale':0.7,'velAf':20,'vcrist':3,'dTp':30,'tingrVite':80,'pressEssTem':90,'pressEssTpo':3,'macMax':30,'calorePlast':135,'tpmv':10,'denA':1.47},
 'PA6 30%FV':{'tipo':'C','family':'PA','dsol':1.36,'dliq':1.17,'ddiff':14,'ritLong':0.2,'ritTrsv':1,'taMin':250,'taCons':270,'taMax':290,'tsMin':63,'tspo':90,'tsMax':95,'testr':133,'pp1min':700,'pp1max':900,'vper':0.4,'vperReale':0.56,'velAf':20,'vcrist':3,'dTp':30,'tingrVite':80,'pressEssTem':90,'pressEssTpo':3,'macMax':20,'calorePlast':120,'tpmv':10,'denA':1.24},
 'PA66':{'tipo':'C','family':'PA','dsol':1.14,'dliq':0.95,'ddiff':17,'ritLong':1.5,'ritTrsv':1.5,'taMin':270,'taCons':290,'taMax':320,'tsMin':60,'tspo':90,'tsMax':100,'testr':158,'pp1min':500,'pp1max':700,'vper':0.5,'vperReale':0.7,'velAf':30,'vcrist':4,'dTp':30,'tingrVite':70,'pressEssTem':80,'pressEssTpo':3,'macMax':30,'calorePlast':180,'tpmv':10,'denA':1.47},
 'PA66 30%FV':{'tipo':'C','family':'PA','dsol':1.37,'dliq':1.2,'ddiff':13,'ritLong':0.4,'ritTrsv':0.8,'taMin':280,'taCons':290,'taMax':300,'tsMin':63,'tspo':90,'tsMax':95,'testr':158,'pp1min':700,'pp1max':900,'vper':0.2,'vperReale':0.32,'velAf':20,'vcrist':2.5,'dTp':30,'tingrVite':80,'pressEssTem':90,'pressEssTpo':3,'macMax':20,'calorePlast':165,'tpmv':10,'denA':0.97},
 'PA610':{'tipo':'C','family':'PA','dsol':1.08,'dliq':0.91,'ddiff':16,'ritLong':1.5,'ritTrsv':1.5,'taMin':250,'taCons':270,'taMax':280,'tsMin':31,'tspo':46,'tsMax':49,'testr':160,'pp1min':500,'pp1max':700,'vper':0.4,'vperReale':0.56,'velAf':30,'vcrist':8,'dTp':30,'tingrVite':80,'pressEssTem':90,'pressEssTpo':3,'macMax':30,'calorePlast':155,'tpmv':8,'denA':1.73},
 'PA612':{'tipo':'C','family':'PA','dsol':1.06,'dliq':0.91,'ddiff':14,'ritLong':1.1,'ritTrsv':1.1,'taMin':240,'taCons':250,'taMax':280,'tsMin':39,'tspo':55,'tsMax':58,'testr':150,'pp1min':500,'pp1max':700,'vper':0.4,'vperReale':0.56,'velAf':30,'vcrist':8,'dTp':30,'tingrVite':80,'pressEssTem':90,'pressEssTpo':3,'macMax':20,'calorePlast':160,'tpmv':14,'denA':1.76},
 'PA612 30%FV':{'tipo':'C','family':'PA','dsol':1.55,'dliq':1.34,'ddiff':14,'ritLong':0.2,'ritTrsv':1.1,'taMin':240,'taCons':275,'taMax':280,'tsMin':52,'tspo':74,'tsMax':78,'testr':157,'pp1min':700,'pp1max':900,'vper':0.2,'vperReale':0.32,'velAf':20,'vcrist':2.5,'dTp':30,'tingrVite':80,'pressEssTem':90,'pressEssTpo':3,'macMax':20,'calorePlast':145,'tpmv':14,'denA':1.08},
 'PET':{'tipo':'C','family':'PET','dsol':1.6,'dliq':1.18,'ddiff':26,'ritLong':0.25,'ritTrsv':0.85,'taMin':270,'taCons':280,'taMax':300,'tsMin':70,'tspo':100,'tsMax':106,'testr':180,'pp1min':600,'pp1max':800,'vper':0.4,'vperReale':0.56,'velAf':20,'vcrist':4,'dTp':30,'tingrVite':100,'pressEssTem':120,'pressEssTpo':3,'macMax':30,'calorePlast':115,'tpmv':7,'denA':0.74},
 'PET 30%FV':{'tipo':'C','family':'PET','dsol':1.85,'dliq':1.42,'ddiff':23,'ritLong':2,'ritTrsv':2,'taMin':270,'taCons':280,'taMax':290,'tsMin':70,'tspo':100,'tsMax':106,'testr':180,'pp1min':700,'pp1max':900,'vper':0.3,'vperReale':0.42,'velAf':15,'vcrist':3.5,'dTp':30,'tingrVite':130,'pressEssTem':205,'pressEssTpo':12,'macMax':30,'calorePlast':205,'tpmv':5,'denA':1.1},
 'PET amorfo':{'tipo':'C','family':'PET','dsol':1.6,'dliq':1.18,'ddiff':26,'ritLong':0.25,'ritTrsv':0.85,'taMin':280,'taCons':280,'taMax':290,'tsMin':10,'tspo':25,'tsMax':28,'testr':66,'pp1min':600,'pp1max':800,'vper':0.4,'vperReale':0.56,'velAf':20,'vcrist':None,'dTp':30,'tingrVite':90,'pressEssTem':120,'pressEssTpo':4,'macMax':30,'calorePlast':210,'tpmv':7,'denA':0.7},
 'PBT':{'tipo':'C','family':'PBT','dsol':1.4,'dliq':1.1,'ddiff':21,'ritLong':0.5,'ritTrsv':0.5,'taMin':240,'taCons':250,'taMax':270,'tsMin':60,'tspo':90,'tsMax':100,'testr':170,'pp1min':500,'pp1max':700,'vper':0.4,'vperReale':0.56,'velAf':20,'vcrist':4,'dTp':30,'tingrVite':100,'pressEssTem':135,'pressEssTpo':3,'macMax':20,'calorePlast':115,'tpmv':7,'denA':0.74},
 'LCP':{'tipo':'C','family':'LCP','dsol':1.4,'dliq':1.25,'ddiff':10,'ritLong':0.2,'ritTrsv':1,'taMin':270,'taCons':285,'taMax':295,'tsMin':56,'tspo':80,'tsMax':85,'testr':247,'pp1min':500,'pp1max':700,'vper':0.5,'vperReale':0.7,'velAf':20,'vcrist':4,'dTp':30,'tingrVite':110,'pressEssTem':150,'pressEssTpo':6,'macMax':20,'calorePlast':165,'tpmv':4,'denA':0.84},
 'PELD':{'tipo':'C','family':'PE','dsol':0.9,'dliq':0.71,'ddiff':21,'ritLong':3.5,'ritTrsv':3,'taMin':200,'taCons':220,'taMax':260,'tsMin':25,'tspo':40,'tsMax':43,'testr':80,'pp1min':400,'pp1max':600,'vper':0.4,'vperReale':0.56,'velAf':12,'vcrist':6,'dTp':30,'tingrVite':20,'pressEssTem':None,'pressEssTpo':None,'macMax':20,'calorePlast':125,'tpmv':14,'denA':1.7},
 'PEHD':{'tipo':'C','family':'PE','dsol':0.96,'dliq':0.71,'ddiff':26,'ritLong':3,'ritTrsv':3,'taMin':220,'taCons':240,'taMax':300,'tsMin':25,'tspo':40,'tsMax':43,'testr':100,'pp1min':400,'pp1max':700,'vper':0.3,'vperReale':0.42,'velAf':8,'vcrist':6,'dTp':30,'tingrVite':20,'pressEssTem':None,'pressEssTpo':None,'macMax':20,'calorePlast':185,'tpmv':14,'denA':1.96},
 'PP':{'tipo':'C','family':'PP','dsol':0.91,'dliq':0.73,'ddiff':20,'ritLong':1.6,'ritTrsv':1.2,'taMin':200,'taCons':240,'taMax':280,'tsMin':20,'tspo':50,'tsMax':60,'testr':93,'pp1min':500,'pp1max':700,'vper':0.6,'vperReale':0.84,'velAf':20,'vcrist':6,'dTp':30,'tingrVite':20,'pressEssTem':None,'pressEssTpo':None,'macMax':20,'calorePlast':170,'tpmv':15,'denA':1.2},
 'PP 30%FV':{'tipo':'C','family':'PP','dsol':1.21,'dliq':1.07,'ddiff':12,'ritLong':0.4,'ritTrsv':1.5,'taMin':200,'taCons':250,'taMax':280,'tsMin':35,'tspo':50,'tsMax':53,'testr':93,'pp1min':700,'pp1max':900,'vper':0.5,'vperReale':0.7,'velAf':15,'vcrist':3.5,'dTp':30,'tingrVite':20,'pressEssTem':None,'pressEssTpo':None,'macMax':20,'calorePlast':155,'tpmv':15,'denA':1.3},
 'PPS Ryton cristallino':{'tipo':'C','family':'PPS','dsol':1.98,'dliq':1.78,'ddiff':10,'ritLong':0.25,'ritTrsv':0.55,'taMin':305,'taCons':330,'taMax':340,'tsMin':99,'tspo':142,'tsMax':151,'testr':204,'pp1min':700,'pp1max':900,'vper':0.5,'vperReale':0.7,'velAf':14,'vcrist':3,'dTp':24,'tingrVite':110,'pressEssTem':150,'pressEssTpo':5,'macMax':10,'calorePlast':160,'tpmv':60,'denA':0.57},
 'POM':{'tipo':'C','family':'POM','dsol':1.42,'dliq':1.16,'ddiff':18,'ritLong':2.1,'ritTrsv':1.9,'taMin':200,'taCons':215,'taMax':240,'tsMin':60,'tspo':80,'tsMax':100,'testr':118,'pp1min':600,'pp1max':800,'vper':0.5,'vperReale':0.7,'velAf':20,'vcrist':8,'dTp':24,'tingrVite':90,'pressEssTem':90,'pressEssTpo':2,'macMax':10,'calorePlast':145,'tpmv':16,'denA':1.33},
 'POM 30%FV':{'tipo':'C','family':'POM','dsol':1.56,'dliq':1.38,'ddiff':12,'ritLong':1.2,'ritTrsv':2.1,'taMin':200,'taCons':215,'taMax':240,'tsMin':63,'tspo':90,'tsMax':95,'testr':154,'pp1min':750,'pp1max':950,'vper':0.4,'vperReale':0.56,'velAf':15,'vcrist':8,'dTp':24,'tingrVite':90,'pressEssTem':90,'pressEssTpo':2,'macMax':10,'calorePlast':130,'tpmv':16,'denA':0.88},
 'TPE':{'tipo':'C','family':'TPE','dsol':0.91,'dliq':0.79,'ddiff':13,'ritLong':1.1,'ritTrsv':1.3,'taMin':200,'taCons':220,'taMax':240,'tsMin':30,'tspo':45,'tsMax':48,'testr':115,'pp1min':500,'pp1max':700,'vper':0.3,'vperReale':0.42,'velAf':20,'vcrist':5,'dTp':20,'tingrVite':60,'pressEssTem':80,'pressEssTpo':3,'macMax':25,'calorePlast':130,'tpmv':15,'denA':0.98},
 'TPE-O':{'tipo':'C','family':'TPE','dsol':0.94,'dliq':0.77,'ddiff':18,'ritLong':1.6,'ritTrsv':1.8,'taMin':200,'taCons':230,'taMax':250,'tsMin':42,'tspo':60,'tsMax':64,'testr':110,'pp1min':500,'pp1max':700,'vper':0.3,'vperReale':0.42,'velAf':20,'vcrist':5,'dTp':50,'tingrVite':50,'pressEssTem':75,'pressEssTpo':2,'macMax':30,'calorePlast':145,'tpmv':15,'denA':1.35},
 'TPE-U':{'tipo':'C','family':'TPE','dsol':1.31,'dliq':1.18,'ddiff':10,'ritLong':1.2,'ritTrsv':1.4,'taMin':200,'taCons':210,'taMax':220,'tsMin':15,'tspo':30,'tsMax':33,'testr':105,'pp1min':500,'pp1max':700,'vper':0.3,'vperReale':0.42,'velAf':20,'vcrist':5,'dTp':20,'tingrVite':80,'pressEssTem':100,'pressEssTpo':2,'macMax':30,'calorePlast':135,'tpmv':15,'denA':1.35},
}


def _build_material_seed():
    out = []
    for name, m in _RAW_MATS.items():
        code = name.upper().replace(" ", "-").replace(".", "").replace("%", "")[:20]
        out.append({
            "code": code, "name": name, "family": m["family"],
            "material_type": "cristallino" if m["tipo"] == "C" else "amorfo",
            "density_liquid": m["dliq"], "density_solid": m["dsol"],
            "density_apparent": m.get("denA"),
            "thermal_factor_a": m["ddiff"],  # ddiff è il coefficiente termico usato in TRr
            "crystallization_velocity": m.get("vcrist"),
            "melt_temp_min": m["taMin"], "melt_temp_recommended": m["taCons"], "melt_temp_max": m["taMax"],
            "mold_temp_min": m["tsMin"], "mold_temp_recommended": m["tspo"], "mold_temp_max": m["tsMax"],
            "ejection_temp": m["testr"],
            "shrink_long": m.get("ritLong"), "shrink_transverse": m.get("ritTrsv"),
            "max_peripheral_speed": m["vper"], "real_peripheral_speed": m.get("vperReale"),
            "front_velocity": m.get("velAf"),
            "pp1_min": m.get("pp1min"), "pp1_max": m.get("pp1max"),
            "dt_profile": m.get("dTp"),
            "heat_plastification": m.get("calorePlast"),
            "screw_ingress_temp": m.get("tingrVite"),
            "dry_temp": m.get("pressEssTem"), "dry_time": m.get("pressEssTpo"),
            "max_barrel_use_pct": m.get("macMax"),
            "max_residence_time": m.get("tpmv"),
            "notes": "",
        })
    return out


MATERIAL_SEED = _build_material_seed()


@app.on_event("startup")
async def seed_data():
    # Admin user
    if not await db.users.find_one({"username": "admin"}):
        hashed = bcrypt.hashpw("admin123".encode(), bcrypt.gensalt()).decode()
        await db.users.insert_one({
            "id": str(uuid.uuid4()), "username": "admin", "password": hashed,
            "full_name": "Amministratore", "role": "admin", "created_at": now_iso(),
        })
        logger.info("Seeded admin user")

    # Attrezzista test
    if not await db.users.find_one({"username": "attrezzista"}):
        hashed = bcrypt.hashpw("test123".encode(), bcrypt.gensalt()).decode()
        await db.users.insert_one({
            "id": str(uuid.uuid4()), "username": "attrezzista", "password": hashed,
            "full_name": "Mario Rossi", "role": "attrezzista", "created_at": now_iso(),
        })

    # Defects — upsert by code (aggiorna i contenuti se il codice esiste già,
    # inserisce se nuovo) e rimuove i vecchi codici segnaposto non più presenti
    # nel catalogo attuale, cosi' un aggiornamento del manuale difetti si
    # riflette senza dover svuotare manualmente il database.
    current_codes = {d["code"] for d in DEFECT_SEED}
    for d in DEFECT_SEED:
        existing = await db.defects.find_one({"code": d["code"]})
        if existing:
            await db.defects.update_one({"code": d["code"]}, {"$set": d})
        else:
            doc = {"id": str(uuid.uuid4()), "created_at": now_iso(), **d}
            await db.defects.insert_one(doc)
    await db.defects.delete_many({"code": {"$nin": list(current_codes)}})

    # Materials — re-seed if the collection has less than the full catalog (upgrade from CycleTime Pro)
    existing_count = await db.materials.count_documents({})
    if existing_count < len(MATERIAL_SEED):
        for m in MATERIAL_SEED:
            if not await db.materials.find_one({"code": m["code"]}):
                doc = {"id": str(uuid.uuid4()), "created_at": now_iso(), **m}
                await db.materials.insert_one(doc)


@app.on_event("shutdown")
async def shutdown():
    client.close()


@api_router.get("/")
async def root():
    return {"message": "Mold Assist API"}


app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get('CORS_ORIGINS', '*').split(','),
    allow_methods=["*"],
    allow_headers=["*"],
)
