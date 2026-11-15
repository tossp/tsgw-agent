"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import {
  ConfigButton, ConfigDetail, ConfigDetailStack, ConfigDetailTitle, ConfigEmptyState, ConfigListAction,
  ConfigNotice, ConfigPanelShell, ConfigSidebar, ConfigSidebarItem, ConfigSidebarList, ConfigSidebarText,
  ConfigSplitView, ConfigStatusDot, useConfigDetailNavigation,
} from "@/components/SettingsUi";
import { ImBotDetail, ImFormActions, ImIdField, ImTextField } from "./ImBotDetail";
import { imCopy, parseImIds, type ImCopy } from "./im-ui";
import { useImSettings } from "./useImSettings";
import type { ImAction, ImChannel, WeixinLoginResult } from "./types";
import styles from "./im-settings.module.css";

function ImCreateBot({ cwd: initialCwd, copy, busy, login, act, cancelLogin }: {
  cwd: string | null; copy: ImCopy; busy: boolean; login: WeixinLoginResult | null; cancelLogin: () => Promise<boolean>;
  act: (action: ImAction) => Promise<boolean>;
}) {
  const [channel, setChannel] = useState<ImChannel>("telegram");
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState(initialCwd ?? "");
  const [token, setToken] = useState("");
  const [users, setUsers] = useState("");
  const [chats, setChats] = useState("");
  const waiting = channel === "weixin" && (login?.state === "waiting" || login?.state === "scanned");
  const reason = busy ? copy.saving : waiting ? copy[login!.state] : !name.trim() || !cwd.trim() ? copy.required
    : channel === "telegram" && (!token.trim() || !parseImIds(users).length) ? copy.tokenRequired : "";
  const create = async () => {
    if (channel === "weixin") {
      await act({ action: "login-weixin", name: name.trim(), cwd: cwd.trim() });
    } else if (await act({ action: "add-telegram", name: name.trim(), cwd: cwd.trim(), token: token.trim(),
      allowedUserIds: parseImIds(users), allowedChatIds: parseImIds(chats),
    })) {
      setToken("");
    }
  };
  return <ConfigDetailStack>
    <ConfigDetailTitle>{copy.add}</ConfigDetailTitle>
    <fieldset className={styles.fields} disabled={busy || waiting}>
      <legend className="sr-only">{copy.add}</legend>
      <div className={styles.actions} role="radiogroup" aria-label={copy.add}>
        {(["telegram", "weixin"] as const).map((value) => <label key={value} className={styles.channel}>
          <input type="radio" name="im-channel" value={value} checked={channel === value} onChange={() => setChannel(value)} />{copy[value]}
        </label>)}
      </div>
      <ImTextField label={copy.name} value={name} onChange={setName} />
      <ImTextField label={copy.cwd} value={cwd} onChange={setCwd} />
      {channel === "telegram" ? <>
        <ImTextField label={copy.token} value={token} onChange={setToken} password />
        <ImIdField label={copy.users} value={users} onChange={setUsers} hint={copy.idsHint} />
        <ImIdField label={copy.chats} value={chats} onChange={setChats} hint={copy.chatsHint} />
      </> : <p className={styles.hint}>{copy.ownerHint}</p>}
    </fieldset>
    <ImFormActions busy={busy} reason={reason}>
      <ConfigButton variant="primary" disabled={Boolean(reason)} onClick={() => void create()}>{channel === "telegram" ? copy.create : copy.scan}</ConfigButton>
    </ImFormActions>
    {channel === "weixin" && login && <div className={styles.login}>
      <p role="status">{copy[login.state]}</p>
      {waiting && <>
        {login.qrImage?.startsWith("data:image/png;base64,") ?
          // The management API supplies a local PNG data URL; it is never sent to an external QR service.
          // eslint-disable-next-line @next/next/no-img-element
          <img className={styles.qr} src={login.qrImage} width={240} height={240} alt={copy.scanAlt} />
          : <p role="alert">{copy.unavailableQr}</p>}
        <ConfigButton disabled={busy} onClick={() => void cancelLogin()}>{copy.cancel}</ConfigButton>
        <p className={styles.hint}>{copy.scanHint}</p>
      </>}
      {login.error && <ConfigNotice><span role="alert">{login.error}</span></ConfigNotice>}
    </div>}
  </ConfigDetailStack>;
}

export function ImSettings({ cwd, onClose }: { cwd: string | null; onClose: () => void }) {
  const { locale } = useI18n();
  const copy = imCopy(locale);
  const { snapshot, login, error, busy, act, refresh, cancelLogin } = useImSettings();
  const [selection, setSelection] = useState<string | null>(null);
  const navigation = useConfigDetailNavigation();
  const bot = snapshot?.bots.find((item) => item.id === selection);
  return <ConfigPanelShell embedded title={copy.title} onClose={onClose}>
    <ConfigSplitView>
      <ConfigSidebar>
        <ConfigSidebarList>
          {snapshot?.bots.map((item) => <ConfigSidebarItem key={item.id} active={selection === item.id} onClick={() => setSelection(item.id)}>
            <ConfigStatusDot active={item.status.state === "connected"} />
            <ConfigSidebarText>{item.name}</ConfigSidebarText>
            <span className={styles.badge}>{item.channel === "weixin" ? copy.weixin : copy.telegram}</span>
          </ConfigSidebarItem>)}
          {snapshot && !snapshot.bots.length && <ConfigEmptyState>{copy.noBots}</ConfigEmptyState>}
          {!snapshot && !error && <p role="status" className={styles.hint}>{copy.loading}</p>}
        </ConfigSidebarList>
        <ConfigListAction active={selection === "add"} onClick={() => setSelection("add")}>{copy.add}</ConfigListAction>
      </ConfigSidebar>
      <ConfigDetail>
        {error && <ConfigNotice action={<ConfigButton size="small" disabled={busy} onClick={() => void refresh()}>{copy.refresh}</ConfigButton>}><span role="alert">{error}</span></ConfigNotice>}
        {selection === "add" ? <ImCreateBot cwd={cwd} copy={copy} busy={busy} login={login} act={act} cancelLogin={cancelLogin} />
          : bot ? <ImBotDetail key={bot.id} bot={bot} copy={copy} busy={busy} act={act}
            conversations={snapshot?.conversations.filter((item) => item.botId === bot.id) ?? []}
            onRemoved={() => { setSelection(null); navigation.closeDetail(); }} />
            : <ConfigEmptyState>{copy.selectBot}</ConfigEmptyState>}
      </ConfigDetail>
    </ConfigSplitView>
  </ConfigPanelShell>;
}
