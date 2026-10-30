import { CameraView, useCameraPermissions } from 'expo-camera';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { AppState, Image, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import mark from '../../assets/mark.png';
import type { PairOutcome } from '../native/pair';
import {
  daemonFingerprint,
  readPairingQr,
  type QrRefusal,
  type ScannedPairing,
} from '../native/pairingQr';
import { Button } from '../ui/button';
import { Backdrop, Glass } from '../ui/glass';
import { success } from '../ui/haptics';
import { Icon } from '../ui/icon';
import { Moment } from '../ui/moment';
import { Breathe, Halo, Pop, Rise } from '../ui/motion';
import { font, radius, space, usePalette } from '../ui/theme';

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
      return 'That code doesn’t name an https relay.';
    case 'unreadable':
      return 'That isn’t a pairing code.';
  }
}

function outcomeText(outcome: Exclude<PairOutcome, 'waiting'>): string {
  switch (outcome) {
    case 'cancelled':
      return 'Face ID did not confirm.';
    case 'attest-failed':
      return 'This phone couldn’t be attested. That needs a real iPhone.';
    case 'unavailable':
      return 'This phone has no Secure Enclave, so it can’t pair.';
    case 'undelivered':
      return 'The request didn’t reach the relay. Check your connection.';
    case 'unstored':
      return 'The relay has the request, but this phone couldn’t keep it. Scan a new code.';
    case 'unverified':
      return 'The pairing request couldn’t be made.';
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
          success();
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

  if (phase.name === 'sending') return <Moment title="Checking this phone…" />;

  if (phase.name === 'error') {
    return (
      <Moment icon="exclamationmark.triangle" title="Not paired" copy={phase.text}>
        <Button label="Scan again" icon="qrcode.viewfinder" onPress={scanAgain} />
      </Moment>
    );
  }

  if (phase.name === 'paired') {
    return (
      <View style={[styles.screen, { backgroundColor: p.bg }]}>
        <Backdrop />
        <ScrollView contentContainerStyle={styles.center}>
          <Pop style={styles.hero}>
            <Halo color={p.tint}>
              <Image source={mark} style={styles.mark} accessibilityIgnoresInvertColors />
            </Halo>
          </Pop>
          <Rise index={1}>
            <Text
              accessibilityRole="header"
              style={[styles.headline, styles.centered, { color: p.text }]}
            >
              Paired with {phase.team}
            </Text>
          </Rise>
          <Rise index={2}>
            <Text style={[styles.copy, styles.centered, { color: p.muted }]}>
              Asks reach you here while you’re away from your desk.
            </Text>
          </Rise>
          {phase.fingerprint ? (
            <Rise index={3} style={styles.stretch}>
              <Fingerprint value={phase.fingerprint} label="Approved by the daemon" />
            </Rise>
          ) : null}
          <Rise index={4} style={styles.stretch}>
            <Button label="Done" onPress={() => router.back()} />
          </Rise>
        </ScrollView>
      </View>
    );
  }

  const head =
    phase.name === 'scan'
      ? { title: 'Scan the code', copy: 'It’s on your computer, under Pair a phone.' }
      : phase.name === 'confirm'
        ? {
            title: 'Check the match',
            copy: `Same as your computer shows? Team ${phase.scanned.qr.team}.`,
          }
        : {
            title: 'Approve on your computer',
            copy: 'Use a passkey you already have. This phone can’t approve itself.',
          };

  return (
    <View style={[styles.screen, { backgroundColor: p.bg }]}>
      <Backdrop />
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
        <Rise style={styles.head}>
          <Text accessibilityRole="header" style={[styles.headline, { color: p.text }]}>
            {head.title}
          </Text>
          <Text style={[styles.copy, { color: p.muted }]}>{head.copy}</Text>
        </Rise>

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
          <>
            <Rise index={1}>
              <Fingerprint value={phase.scanned.fingerprint} label="Daemon fingerprint" />
            </Rise>
            <Rise index={2} style={styles.actions}>
              <Button
                label="They match"
                icon="checkmark"
                onPress={() => void confirm(phase.scanned)}
              />
              <Button label="Scan a different code" kind="secondary" onPress={scanAgain} />
            </Rise>
          </>
        ) : null}

        {phase.name === 'waiting' ? (
          <>
            <Rise index={1} style={styles.waiting}>
              <View style={styles.dots}>
                {[0, 1, 2].map((i) => (
                  <Breathe key={i} delay={i * 220}>
                    <View style={[styles.dot, { backgroundColor: p.accent }]} />
                  </Breathe>
                ))}
              </View>
              <Text style={[styles.small, { color: p.muted }]}>Waiting for approval</Text>
            </Rise>
            {phase.fingerprint ? (
              <Rise index={2}>
                <Fingerprint value={phase.fingerprint} label="Daemon fingerprint" />
              </Rise>
            ) : null}
            <Rise index={3} style={styles.actions}>
              <Button label="Scan a new code" kind="secondary" onPress={scanAgain} />
              <Text style={[styles.small, styles.centered, { color: p.muted }]}>
                Nothing after a minute? The code was refused or already used.
              </Text>
            </Rise>
          </>
        ) : null}
      </ScrollView>
    </View>
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
    <>
      <Rise index={1}>
        {props.granted ? (
          <View style={styles.camera}>
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={(event) => props.onCode(event.data)}
              accessibilityLabel="Pairing code scanner"
            />
            <View pointerEvents="none" style={styles.finder}>
              {CORNERS.map((corner) => (
                <View
                  key={corner.key}
                  style={[styles.corner, corner.style, { borderColor: p.accent }]}
                />
              ))}
            </View>
          </View>
        ) : (
          <Glass style={styles.cameraOff}>
            <Icon name="camera" color={p.muted} size={30} />
            <Text style={[styles.copy, styles.centered, { color: p.muted }]}>
              {props.canAsk
                ? 'The camera reads the code.'
                : 'Turn the camera on in Settings, or paste the code.'}
            </Text>
            {props.canAsk ? (
              <Button label="Allow the camera" icon="camera" onPress={props.onRequest} />
            ) : null}
          </Glass>
        )}
      </Rise>
      <Rise index={2} style={styles.actions}>
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
            <Button label="Use this code" kind="secondary" onPress={props.onSubmitPaste} />
          </>
        ) : (
          <Button label="Paste the code instead" kind="quiet" onPress={props.onRevealPaste} />
        )}
      </Rise>
    </>
  );
}

function Fingerprint({ value, label }: { value: string; label: string }) {
  const p = usePalette();
  return (
    <Glass style={styles.print}>
      <Text style={[styles.label, { color: p.muted }]}>{label}</Text>
      <Text
        selectable
        accessibilityLabel={`${label} ${value}`}
        style={[styles.fingerprint, { color: p.text }]}
      >
        {value}
      </Text>
    </Glass>
  );
}

const CORNER = 28;
const CORNERS = [
  {
    key: 'tl',
    style: { top: 0, left: 0, borderTopWidth: 4, borderLeftWidth: 4, borderTopLeftRadius: 14 },
  },
  {
    key: 'tr',
    style: { top: 0, right: 0, borderTopWidth: 4, borderRightWidth: 4, borderTopRightRadius: 14 },
  },
  {
    key: 'bl',
    style: {
      bottom: 0,
      left: 0,
      borderBottomWidth: 4,
      borderLeftWidth: 4,
      borderBottomLeftRadius: 14,
    },
  },
  {
    key: 'br',
    style: {
      bottom: 0,
      right: 0,
      borderBottomWidth: 4,
      borderRightWidth: 4,
      borderBottomRightRadius: 14,
    },
  },
] as const;

const styles = StyleSheet.create({
  screen: { flex: 1 },
  page: { padding: space.lg, paddingTop: space.md, gap: space.lg, paddingBottom: space.xl * 2 },
  center: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
    gap: space.md,
  },
  head: { gap: space.xs },
  headline: { fontFamily: font.display, fontSize: 30, lineHeight: 36, letterSpacing: -0.7 },
  copy: { fontFamily: font.regular, fontSize: 15, lineHeight: 22 },
  small: { fontFamily: font.regular, fontSize: 13, lineHeight: 18 },
  centered: { textAlign: 'center' },
  stretch: { alignSelf: 'stretch' },
  hero: { alignItems: 'center', marginVertical: space.xl },
  mark: { width: 88, height: 88 },
  actions: { gap: space.sm },
  print: { padding: space.lg, gap: space.sm, alignItems: 'center' },
  label: {
    fontFamily: font.semibold,
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  fingerprint: {
    fontFamily: font.medium,
    fontSize: 20,
    lineHeight: 28,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
    letterSpacing: 1,
  },
  camera: { width: '100%', aspectRatio: 1, borderRadius: 22, overflow: 'hidden' },
  finder: { position: 'absolute', top: '18%', left: '18%', right: '18%', bottom: '18%' },
  corner: { position: 'absolute', width: CORNER, height: CORNER },
  cameraOff: {
    aspectRatio: 1,
    padding: space.xl,
    gap: space.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  waiting: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  dots: { flexDirection: 'row', gap: space.sm },
  dot: { width: 10, height: 10, borderRadius: radius.pill },
  paste: {
    minHeight: 88,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: space.md,
    fontFamily: font.regular,
    fontSize: 15,
    lineHeight: 21,
    textAlignVertical: 'top',
  },
});
