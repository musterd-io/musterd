import { CameraView, useCameraPermissions } from 'expo-camera';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { AppState, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { PairOutcome } from '../native/pair';
import {
  daemonFingerprint,
  readPairingQr,
  type QrRefusal,
  type ScannedPairing,
} from '../native/pairingQr';
import { radius, space, usePalette } from '../ui/theme';

/**
 * Pairing (ADR 676 §5, ADR 727). The camera reads the QR on the daemon's page. The fingerprint
 * is shown, and nothing is generated or sent until the person says it matches the page — the
 * code is single-use. After the relay accepts the request the screen waits. A standing key on
 * the computer approves this phone. This screen never approves it.
 */

type Phase =
  | { name: 'scan' }
  | { name: 'confirm'; scanned: ScannedPairing }
  | { name: 'sending' }
  | { name: 'waiting'; fingerprint: string }
  | { name: 'paired'; fingerprint: string | null; team: string }
  | { name: 'error'; text: string };

function refusalText(reason: QrRefusal): string {
  switch (reason) {
    case 'expired':
      return 'That code has expired. Start a new one on the computer.';
    case 'relay':
      return 'That code does not name an https relay.';
    case 'unreadable':
      return 'That is not a pairing code.';
  }
}

function outcomeText(outcome: Exclude<PairOutcome, 'waiting'>): string {
  switch (outcome) {
    case 'cancelled':
      return 'Face ID did not confirm.';
    case 'attest-failed':
      return 'This phone could not be attested. That check needs a real device.';
    case 'unavailable':
      return 'This phone has no Secure Enclave, so it cannot pair.';
    case 'undelivered':
      return 'The request did not reach the relay.';
    case 'unstored':
      return 'The request reached the relay, but this phone could not store it. Scan a new code.';
    case 'unverified':
      return 'The pairing request could not be made.';
  }
}

export default function PairScreen() {
  const p = usePalette();
  const [permission, requestPermission] = useCameraPermissions();
  const [phase, setPhase] = useState<Phase>({ name: 'scan' });
  const [paste, setPaste] = useState('');
  const [showPaste, setShowPaste] = useState(false);
  const lock = useRef(false);
  const phaseName = phase.name;

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const { loadPairingPin } = await import('../native/pairingPin');
        const pin = await loadPairingPin();
        if (!alive || lock.current || !pin) return;
        const fingerprint = daemonFingerprint(pin.identity);
        setPhase(
          pin.binding
            ? { name: 'paired', fingerprint, team: pin.team }
            : { name: 'waiting', fingerprint: fingerprint ?? '' },
        );
      } catch {
        // Expo Go has no key module. The scan still parses a code.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (phaseName !== 'waiting') return;
    let alive = true;
    const look = () => {
      void (async () => {
        try {
          const { loadPairingPin } = await import('../native/pairingPin');
          const pin = await loadPairingPin();
          if (!alive || !pin?.binding) return;
          setPhase({
            name: 'paired',
            fingerprint: daemonFingerprint(pin.identity),
            team: pin.team,
          });
        } catch {
          // Still waiting. A later poll retries.
        }
      })();
    };
    look();
    const timer = setInterval(look, 2_000);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') look();
    });
    return () => {
      alive = false;
      clearInterval(timer);
      sub.remove();
    };
  }, [phaseName]);

  function take(text: string) {
    const read = readPairingQr(text.trim());
    if (!read.ok) {
      lock.current = true;
      setPhase({ name: 'error', text: refusalText(read.reason) });
      return;
    }
    lock.current = true;
    setPhase({ name: 'confirm', scanned: read.scanned });
  }

  function scanAgain() {
    lock.current = false;
    setPaste('');
    setPhase({ name: 'scan' });
  }

  async function confirm(scanned: ScannedPairing) {
    setPhase({ name: 'sending' });
    try {
      const { sendPairingRequest } = await import('../native/pair');
      const outcome = await sendPairingRequest({ scanned });
      if (outcome === 'waiting') {
        setPhase({ name: 'waiting', fingerprint: scanned.fingerprint });
        return;
      }
      setPhase({ name: 'error', text: outcomeText(outcome) });
    } catch {
      setPhase({ name: 'error', text: outcomeText('unverified') });
    }
  }

  return (
    <ScrollView
      style={{ backgroundColor: p.bg }}
      contentContainerStyle={styles.body}
      keyboardShouldPersistTaps="handled"
    >
      {phase.name === 'scan' ? (
        <Scan
          granted={permission?.granted === true}
          canAsk={permission?.canAskAgain !== false}
          showPaste={showPaste || permission?.granted === false}
          paste={paste}
          onPaste={setPaste}
          onSubmitPaste={() => take(paste)}
          onRequest={() => void requestPermission()}
          onRevealPaste={() => setShowPaste(true)}
          onCode={take}
        />
      ) : null}

      {phase.name === 'confirm' ? (
        <View style={styles.block}>
          <Text style={[styles.title, { color: p.text }]}>Compare this fingerprint</Text>
          <Fingerprint value={phase.scanned.fingerprint} color={p.text} />
          <Text style={[styles.copy, { color: p.muted }]}>
            It should match the fingerprint beside the code on your computer. Team{' '}
            {phase.scanned.qr.team}.
          </Text>
          <Button
            label="The fingerprints match"
            bg={p.accent}
            fg={p.onAccent}
            onPress={() => void confirm(phase.scanned)}
          />
          <Button label="Scan a different code" bg={p.raised} fg={p.text} onPress={scanAgain} />
        </View>
      ) : null}

      {phase.name === 'sending' ? (
        <Text style={[styles.copy, { color: p.muted }]}>Checking this phone…</Text>
      ) : null}

      {phase.name === 'waiting' ? (
        <View style={styles.block}>
          <Text style={[styles.title, { color: p.text }]}>Waiting for approval</Text>
          {phase.fingerprint ? <Fingerprint value={phase.fingerprint} color={p.text} /> : null}
          <Text style={[styles.copy, { color: p.muted }]}>
            Approve this phone on the computer, with a key you already have. This phone cannot
            approve itself. If nothing arrives, the code was refused or already used.
          </Text>
          <Button label="Scan a new code" bg={p.raised} fg={p.text} onPress={scanAgain} />
        </View>
      ) : null}

      {phase.name === 'paired' ? (
        <View style={styles.block}>
          <Text style={[styles.title, { color: p.text }]}>Paired with {phase.team}</Text>
          <Text style={[styles.copy, { color: p.text }]}>
            Asks for you come to this phone while you’re away from your computer. At your desk,
            they stay on the computer.
          </Text>
          <Text style={[styles.copy, { color: p.muted }]}>
            To change which asks come here, and when, open /live on your computer: Settings, then
            You, then Away channels.
          </Text>
          {phase.fingerprint ? <Fingerprint value={phase.fingerprint} color={p.text} /> : null}
          <Text style={[styles.copy, { color: p.muted }]}>
            The fingerprint is the daemon that approved this phone.
          </Text>
          <Button label="Asks" bg={p.accent} fg={p.onAccent} onPress={() => router.back()} />
        </View>
      ) : null}

      {phase.name === 'error' ? (
        <View style={styles.block}>
          <Text style={[styles.title, { color: p.text }]}>{phase.text}</Text>
          <Button label="Scan again" bg={p.accent} fg={p.onAccent} onPress={scanAgain} />
        </View>
      ) : null}
    </ScrollView>
  );
}

function Scan(props: {
  granted: boolean;
  canAsk: boolean;
  showPaste: boolean;
  paste: string;
  onPaste: (value: string) => void;
  onSubmitPaste: () => void;
  onRequest: () => void;
  onRevealPaste: () => void;
  onCode: (text: string) => void;
}) {
  const p = usePalette();
  return (
    <View style={styles.block}>
      <Text style={[styles.title, { color: p.text }]}>Scan the pairing code</Text>
      <Text style={[styles.copy, { color: p.muted }]}>
        Point the camera at the code on your computer.
      </Text>
      {props.granted ? (
        <CameraView
          style={styles.camera}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={(event) => props.onCode(event.data)}
          accessibilityLabel="Pairing code scanner"
        />
      ) : (
        <Button
          label={props.canAsk ? 'Allow the camera' : 'The camera is off'}
          bg={p.accent}
          fg={p.onAccent}
          onPress={props.onRequest}
        />
      )}
      {props.showPaste ? (
        <>
          <TextInput
            value={props.paste}
            onChangeText={props.onPaste}
            placeholder="Paste the pairing code"
            placeholderTextColor={p.placeholder}
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            accessibilityLabel="Pairing code"
            style={[
              styles.paste,
              { color: p.text, borderColor: p.border, backgroundColor: p.surface },
            ]}
          />
          <Button label="Use this code" bg={p.raised} fg={p.text} onPress={props.onSubmitPaste} />
        </>
      ) : (
        <Button
          label="Paste the code instead"
          bg={p.raised}
          fg={p.text}
          onPress={props.onRevealPaste}
        />
      )}
    </View>
  );
}

function Fingerprint({ value, color }: { value: string; color: string }) {
  return (
    <Text
      selectable
      accessibilityLabel={`Daemon fingerprint ${value}`}
      style={[styles.fingerprint, { color }]}
    >
      {value}
    </Text>
  );
}

function Button(props: { label: string; bg: string; fg: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      onPress={props.onPress}
      style={[styles.button, { backgroundColor: props.bg }]}
    >
      <Text style={[styles.buttonText, { color: props.fg }]}>{props.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  body: {
    flexGrow: 1,
    padding: space.xl,
    gap: space.lg,
  },
  block: { gap: space.md },
  title: { fontSize: 20, fontWeight: '600', textAlign: 'center' },
  copy: { fontSize: 15, lineHeight: 21, textAlign: 'center' },
  fingerprint: {
    fontSize: 22,
    lineHeight: 28,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
    letterSpacing: 1,
  },
  camera: { width: '100%', aspectRatio: 1, borderRadius: radius.md, overflow: 'hidden' },
  paste: {
    minHeight: 88,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: space.md,
    fontSize: 15,
    lineHeight: 21,
    textAlignVertical: 'top',
  },
  button: {
    minHeight: 44,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  buttonText: { fontSize: 17, fontWeight: '600', textAlign: 'center' },
});
