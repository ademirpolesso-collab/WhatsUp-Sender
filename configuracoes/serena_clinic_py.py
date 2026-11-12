# -*- coding: utf-8 -*-
# configuracoes/serena_clinic_py.py
# Modulo Python 100% stdlib: Config Geral e Config Zelda Separadas + Escudo Anti-Ban (sem status da Zelda na Serena)

import json
import os
import random
import re
import sys
import time
import unicodedata

DEFAULT_SETTINGS = {
    "clinicName": "OdontoCompany Bela Vista Osasco",
    "clinicAddress": "Av Antonio Carlos Costa 991",
    "address": "Av Antonio Carlos Costa 991",
    "parkingInfo": "Estacionamento no local",
    "zeldaGroupEnabled": True,
    "zeldaGroupTarget": "",
    "zeldaCaretakerPhone": "",
    "zeldaApprovalQuorum": 3,
    "serenaKeepUnreadForHuman": True,
    "reactionDelayMinMs": 3000,
    "reactionDelayMaxMs": 7000,
    "typingStateMinMs": 2000,
    "typingStateMaxMs": 5000,
    "betweenBubblesMinMs": 4000,
    "betweenBubblesMaxMs": 8000,
    "maxActiveMessagesPerHour": 30,
    "maxMessageChars": 450,
    "enableSpintax": True,
    "enableOptOutBlacklist": True,
    "timezone": "America/Sao_Paulo",
}


def _strip_accents(value):
    text = str(value or "")
    return "".join(
        ch for ch in unicodedata.normalize("NFD", text) if unicodedata.category(ch) != "Mn"
    ).lower()


def _candidate_paths():
    paths = []
    appdata = os.environ.get("APPDATA")
    localappdata = os.environ.get("LOCALAPPDATA")
    if appdata:
        paths.append(os.path.join(appdata, "mm-sender", "configuracoes", "clinic-settings.json"))
    if localappdata:
        paths.append(os.path.join(localappdata, "mm-sender", "configuracoes", "clinic-settings.json"))
    if getattr(sys, "frozen", False):
        exe_dir = os.path.dirname(sys.executable)
        paths.append(os.path.join(exe_dir, "configuracoes", "clinic-settings.json"))
        paths.append(os.path.join(exe_dir, "clinic-settings.json"))
    here = os.path.dirname(os.path.abspath(__file__))
    paths.append(os.path.join(here, "clinic-settings.json"))
    paths.append(os.path.join(os.getcwd(), "configuracoes", "clinic-settings.json"))
    paths.append(os.path.join(os.getcwd(), "clinic-settings.json"))
    return paths


def get_clinic_settings():
    for p in _candidate_paths():
        try:
            if os.path.isfile(p):
                with open(p, "r", encoding="utf-8") as f:
                    raw = json.load(f)
                name = str(raw.get("clinicName") or raw.get("nomeClinica") or DEFAULT_SETTINGS["clinicName"]).strip()
                addr = str(raw.get("clinicAddress") or raw.get("address") or DEFAULT_SETTINGS["clinicAddress"]).strip()
                zgrp = str(raw.get("zeldaGroupTarget") or raw.get("grupoZelda") or raw.get("zeldaGroup") or "").strip()
                merged = dict(DEFAULT_SETTINGS)
                merged.update(raw)
                merged["clinicName"] = name
                merged["clinicAddress"] = addr
                merged["address"] = addr
                merged["zeldaGroupTarget"] = zgrp
                os.environ["SERENA_CLINIC_NAME"] = name
                os.environ["SERENA_CLINIC_ADDRESS"] = addr
                os.environ["ZELDA_GROUP_TARGET"] = zgrp
                return merged
        except Exception:
            pass
    return dict(DEFAULT_SETTINGS)


def save_clinic_settings(clinic_name=None, clinic_address=None, zelda_group=None, max_per_hour=None, caretaker_phone=None, quorum=None, keep_unread=None):
    current = get_clinic_settings()
    if clinic_name is not None:
        current["clinicName"] = str(clinic_name).strip() or DEFAULT_SETTINGS["clinicName"]
    if clinic_address is not None:
        addr = str(clinic_address).strip() or DEFAULT_SETTINGS["clinicAddress"]
        current["clinicAddress"] = addr
        current["address"] = addr
    if zelda_group is not None:
        current["zeldaGroupTarget"] = str(zelda_group).strip()
        current["grupoZelda"] = current["zeldaGroupTarget"]
    if caretaker_phone is not None:
        current["zeldaCaretakerPhone"] = str(caretaker_phone).strip()
        current["whatsappZelador"] = current["zeldaCaretakerPhone"]
    if quorum is not None:
        current["zeldaApprovalQuorum"] = max(1, min(20, int(quorum or 3)))
    if keep_unread is not None:
        current["serenaKeepUnreadForHuman"] = bool(keep_unread)
    if max_per_hour is not None:
        current["maxActiveMessagesPerHour"] = min(30, max(5, int(max_per_hour or 30)))

    targets = []
    appdata = os.environ.get("APPDATA")
    if appdata:
        targets.append(os.path.join(appdata, "mm-sender", "configuracoes", "clinic-settings.json"))
    here = os.path.dirname(os.path.abspath(__file__))
    targets.append(os.path.join(here, "clinic-settings.json"))
    targets.append(os.path.join(os.getcwd(), "configuracoes", "clinic-settings.json"))

    seen = set()
    for dest in targets:
        if dest in seen:
            continue
        seen.add(dest)
        try:
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, "w", encoding="utf-8") as f:
                json.dump(current, f, ensure_ascii=False, indent=2)
        except Exception:
            pass
    return current


def resolve_spintax(text):
    out = str(text or "")
    pattern = re.compile(r"\{([^{}]+\|[^{}]+)\}")
    for _ in range(10):
        if not pattern.search(out):
            break
        out = pattern.sub(lambda m: random.choice([opt.strip() for opt in m.group(1).split("|")]), out)
    return out


def apply_antiban_delay():
    cfg = get_clinic_settings()
    delay_s = random.uniform(
        max(3.0, float(cfg.get("reactionDelayMinMs", 3000)) / 1000.0),
        max(5.0, float(cfg.get("reactionDelayMaxMs", 7000)) / 1000.0),
    )
    time.sleep(delay_s)


def _compact_zelda_token(val):
    return re.sub(r"[^a-z0-9]+", "", _strip_accents(val))


def matches_zelda_group(group_id_or_name):
    cfg = get_clinic_settings()
    if not cfg.get("zeldaGroupEnabled", True):
        return False
    raw_target = str(cfg.get("zeldaGroupTarget", "") or "").strip()
    candidate = _strip_accents(group_id_or_name).strip()
    cand_compact = _compact_zelda_token(group_id_or_name)
    if not raw_target or not candidate:
        return False
    for item in re.split(r"[,;
|]+", raw_target):
        t = _strip_accents(item).strip()
        tc = _compact_zelda_token(item)
        if not t:
            continue
        if t == candidate or t in candidate or candidate in t:
            return True
        if tc and cand_compact and (tc == cand_compact or (len(tc) >= 4 and (tc in cand_compact or cand_compact in tc))):
            return True
    return False


def _is_config_label(label_text):
    norm = _strip_accents(label_text).strip()
    if not norm or len(norm) > 45:
        return False
    for kw in ("configuracoes", "configuracao", "config", "ajustes", "parametros", "settings"):
        if kw in norm:
            return True
    return False


def _find_tk_settings_container(widget):
    try:
        tab_dict = getattr(widget, "_tab_dict", None)
        if isinstance(tab_dict, dict):
            for tab_name, tab_frame in tab_dict.items():
                if _is_config_label(tab_name):
                    return tab_frame
    except Exception:
        pass

    try:
        if hasattr(widget, "tabs") and hasattr(widget, "tab") and callable(widget.tabs):
            for tab_id in widget.tabs():
                try:
                    txt = widget.tab(tab_id, "text")
                    if _is_config_label(txt):
                        return widget.nametowidget(tab_id)
                except Exception:
                    pass
    except Exception:
        pass

    try:
        children = widget.winfo_children()
    except Exception:
        children = []

    for child in children:
        found = _find_tk_settings_container(child)
        if found is not None:
            return found
    return None


def _mount_tk_clinic_box(container):
    if getattr(container, "_serena_clinic_mounted", False):
        return
    setattr(container, "_serena_clinic_mounted", True)

    cfg = get_clinic_settings()
    import tkinter as tk
    from tkinter import ttk

    nb = ttk.Notebook(container)
    frm_geral = tk.Frame(nb, padx=10, pady=8)
    frm_zelda = tk.Frame(nb, padx=10, pady=8)
    nb.add(frm_geral, text=" Config Geral ")
    nb.add(frm_zelda, text=" Config Zelda ")

    # Aba 1: Config Geral (sem campos da Zelda)
    tk.Label(frm_geral, text="Nome da Clinica:").pack(anchor="w")
    ent_name = tk.Entry(frm_geral, width=52)
    ent_name.pack(fill="x", pady=(2, 5))
    ent_name.insert(0, cfg.get("clinicName", ""))

    tk.Label(frm_geral, text="Endereco da Clinica:").pack(anchor="w")
    ent_addr = tk.Entry(frm_geral, width=52)
    ent_addr.pack(fill="x", pady=(2, 5))
    ent_addr.insert(0, cfg.get("clinicAddress", ""))

    var_unread = tk.BooleanVar(value=bool(cfg.get("serenaKeepUnreadForHuman", True)))
    tk.Checkbutton(frm_geral, text="Manter mensagens lidas pela Serena como Nao Lidas no WhatsApp", variable=var_unread).pack(anchor="w", pady=(2, 5))

    status_geral = tk.Label(frm_geral, text="", fg="#059669")
    status_geral.pack(anchor="w")

    def _save_geral():
        save_clinic_settings(clinic_name=ent_name.get(), clinic_address=ent_addr.get(), max_per_hour=30, keep_unread=var_unread.get())
        status_geral.config(text="Config Geral salva!")

    tk.Button(frm_geral, text="Salvar Config Geral", bg="#2563eb", fg="#ffffff", command=_save_geral).pack(anchor="e", pady=(4, 2))

    # Aba 2: Config Zelda (exclusiva da Zelda)
    tk.Label(frm_zelda, text="Grupo Configurado da Zelda (Nome exato ou ID @g.us):").pack(anchor="w")
    ent_zelda = tk.Entry(frm_zelda, width=52)
    ent_zelda.pack(fill="x", pady=(2, 5))
    ent_zelda.insert(0, cfg.get("zeldaGroupTarget", ""))

    tk.Label(frm_zelda, text="WhatsApp do Zelador (Sem Direito a Voto):").pack(anchor="w")
    ent_caretaker = tk.Entry(frm_zelda, width=52)
    ent_caretaker.pack(fill="x", pady=(2, 5))
    ent_caretaker.insert(0, cfg.get("zeldaCaretakerPhone", ""))

    tk.Label(frm_zelda, text="Quorum Minimo de Votos do Conselho:").pack(anchor="w")
    ent_quorum = tk.Entry(frm_zelda, width=16)
    ent_quorum.pack(anchor="w", pady=(2, 5))
    ent_quorum.insert(0, str(cfg.get("zeldaApprovalQuorum", 3)))

    status_zelda = tk.Label(frm_zelda, text="", fg="#059669")
    status_zelda.pack(anchor="w")

    def _save_zelda():
        save_clinic_settings(zelda_group=ent_zelda.get(), caretaker_phone=ent_caretaker.get(), quorum=ent_quorum.get())
        status_zelda.config(text="Config Zelda salva!")

    tk.Button(frm_zelda, text="Salvar Config Zelda", bg="#2563eb", fg="#ffffff", command=_save_zelda).pack(anchor="e", pady=(4, 2))

    try:
        use_grid = len(container.grid_slaves()) > 0 and len(container.pack_slaves()) == 0
    except Exception:
        use_grid = False

    if use_grid:
        max_row = -1
        for sl in container.grid_slaves():
            try:
                r = int(sl.grid_info().get("row", 0))
                if r > max_row:
                    max_row = r
            except Exception:
                pass
        nb.grid(row=max_row + 1, column=0, columnspan=4, sticky="ew", padx=12, pady=8)
    else:
        nb.pack(fill="x", padx=12, pady=8)


def _get_whatsapp_connection_status():
    candidates = []
    appdata = os.environ.get("APPDATA")
    if appdata:
        candidates.append(os.path.join(appdata, "mm-sender", "dados", "whatsapp-connection-status.json"))
    candidates.append(os.path.join(os.getcwd(), "dados", "whatsapp-connection-status.json"))
    for p in candidates:
        try:
            if os.path.isfile(p):
                with open(p, "r", encoding="utf-8") as f:
                    raw = json.load(f)
                age_ms = (time.time() * 1000.0) - float(raw.get("heartbeatEpochMs") or 0)
                if bool(raw.get("connected")) and 0 <= age_ms <= 180000:
                    return True, "Conectada (WhatsApp Online)"
        except Exception:
            pass
    return False, "Desconectada (WhatsApp Offline)"


def _fix_tk_zelda_status_labels(widget, in_serena_screen=False):
    try:
        cls_name = _strip_accents(widget.__class__.__name__)
        if "serena" in cls_name or "dashboard" in cls_name:
            in_serena_screen = True
        elif "zelda" in cls_name:
            in_serena_screen = False

        if hasattr(widget, "cget") and hasattr(widget, "configure"):
            try:
                cur_txt = str(widget.cget("text") or "").strip()
                low_txt = _strip_accents(cur_txt)
                is_zelda_lbl = (
                    low_txt.startswith("ativa (")
                    or ("zelda" in low_txt and ("status" in low_txt or "conectad" in low_txt or "desconectad" in low_txt or "grupo" in low_txt))
                    or ("whatsup" in low_txt and "configurado" in low_txt)
                    or getattr(widget, "_zelda_fixed_lbl", False)
                )
                if is_zelda_lbl and len(cur_txt) < 120:
                    setattr(widget, "_zelda_fixed_lbl", True)
                    if in_serena_screen:
                        if cur_txt != "":
                            widget.configure(text="")
                    else:
                        cfg = get_clinic_settings()
                        grp = cfg.get("zeldaGroupTarget") or "Nao configurado"
                        _ok, conn_txt = _get_whatsapp_connection_status()
                        new_txt = f"{conn_txt} | Grupo Configurado: {grp}"
                        if cur_txt != new_txt:
                            widget.configure(text=new_txt)
            except Exception:
                pass
        for child in widget.winfo_children():
            _fix_tk_zelda_status_labels(child, in_serena_screen)
    except Exception:
        pass


def install_auto_gui_hooks():
    get_clinic_settings()
    try:
        import tkinter as tk
        if not getattr(tk.Misc, "_serena_hooked", False):
            orig_mainloop = tk.Misc.mainloop

            def _patched_mainloop(self, n=0):
                def _scan():
                    try:
                        root = self._root() if hasattr(self, "_root") else self
                        _fix_tk_zelda_status_labels(root, False)
                        target = _find_tk_settings_container(root)
                        if target is not None:
                            _mount_tk_clinic_box(target)
                        root.after(3000, _scan)
                    except Exception:
                        pass

                try:
                    self.after(300, _scan)
                except Exception:
                    pass
                return orig_mainloop(self, n)

            tk.Misc.mainloop = _patched_mainloop
            tk.Misc._serena_hooked = True
    except Exception:
        pass


install_auto_gui_hooks()
