import React, { useCallback, useEffect, useState } from 'react';
import { Switch, Button, Progress, message } from 'antd';
import { CheckCircleFilled, DownloadOutlined } from '@ant-design/icons';
import { SettingsPage, Section, ControlRow } from './settingsKit';
import useVoiceSettings from '../../voice/voiceSettings';
import { voiceAvailable } from '../../voice/engine';

/*
 * Settings → Voice Commands. Per computer: the free offline Whisper
 * speech engine is downloaded here once, and the microphone is this PC's.
 * One model understands Hindi, English and a mix of the two.
 */

const EXAMPLES = [
  ['Create sales bill for Ali', 'New bill with Ali selected, ready to scan'],
  ['Make it 10', 'Quantity of the last item becomes 10'],
  ['Add frock 20 into 20', 'Adds the product "Frock 20*20"'],
  ['Add barcode 8 9 0 1 …', 'Adds the product with that barcode'],
  ['Show Ali ledger / Ali ka statement', "Opens Ali's statement"],
  ['Open that bill / open bill 1452', 'Opens the last bill you viewed, or that number'],
  ['Open stock report / customers dikhao', 'Opens that screen'],
];

export default function VoiceSettings() {
  const { enabled, model: modelKey, speakBack, update, modelInstalled } = useVoiceSettings();
  const api = typeof window !== 'undefined' ? window.electronAPI?.voice : null;
  const [model, setModel] = useState(null);
  const [progress, setProgress] = useState(null);

  const refresh = useCallback(() => {
    if (api) api.modelStatus(modelKey).then(setModel).catch(() => setModel(null));
  }, [api, modelKey]);
  useEffect(refresh, [refresh]);
  useEffect(() => (api ? api.onProgress((p) => { if (p.model === modelKey) setProgress(p); }) : undefined), [api, modelKey]);

  const download = async () => {
    setProgress({ received: 0, total: 1 });
    const res = await api.downloadModel(modelKey);
    setProgress(null);
    if (res?.ok === false) { message.error(`Download failed: ${res.error}. Check the internet connection and try again.`); return; }
    setModel(res);
    modelInstalled();
    message.success('Speech model ready');
  };

  if (!voiceAvailable()) {
    return (
      <SettingsPage title="Voice Commands" sub="Talk to ZEHEN in Hindi, English or a mix.">
        <Section><p className="ms-row-desc">Voice commands work in the ZEHEN desktop app on Windows.</p></Section>
      </SettingsPage>
    );
  }

  const pct = progress ? Math.min(99, Math.round((progress.received / (progress.total || 1)) * 100)) : 0;
  return (
    <SettingsPage
      title="Voice Commands"
      sub="Hold Ctrl+Space and speak in Hindi, English or a mix, then let go. Speech is understood on this computer, offline and free; nothing is recorded or sent anywhere."
    >
      <Section title="Voice">
        <ControlRow label="Use voice commands on this computer" desc="Shows the mic button in the corner and turns on Ctrl+Space.">
          <Switch checked={enabled} onChange={(v) => update({ enabled: v })} />
        </ControlRow>
        <ControlRow
          label="Speech model"
          desc={model?.installed ? `${model.label} is installed (${(model.bytes / 1048576).toFixed(0)} MB).` : `About ${model?.sizeMB || ''} MB, needs internet once. Billing keeps working while it downloads.`}
        >
          {model?.installed
            ? <span style={{ color: 'var(--success)' }}><CheckCircleFilled /> Ready</span>
            : progress
              ? <Progress percent={pct} size="small" style={{ width: 160 }} status="active" />
              : <Button icon={<DownloadOutlined />} onClick={download}>Download</Button>}
        </ControlRow>
      </Section>

      <Section title="Starting a command">
        <ControlRow label="Hotkey" desc="Hold Ctrl+Space (or hold the mic button) while you speak, then let go. Uses nothing while idle.">
          <span className="ms-row-desc">Ctrl+Space</span>
        </ControlRow>
        <ControlRow label="Speak replies" desc={'Says short confirmations like "Ali selected" out loud.'}>
          <Switch checked={speakBack} disabled={!enabled} onChange={(v) => update({ speakBack: v })} />
        </ControlRow>
      </Section>

      <Section title="What you can say" desc="Hindi, English or a mix. Voice only fills the screen; you still save with F1.">
        {EXAMPLES.map(([say, does]) => (
          <ControlRow key={say} label={`"${say}"`} desc={does}><span /></ControlRow>
        ))}
      </Section>
    </SettingsPage>
  );
}
