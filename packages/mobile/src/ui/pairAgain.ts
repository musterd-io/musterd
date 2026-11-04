import { Alert } from 'react-native';

/**
 * "Pair this phone again?" behind a confirm (lane 01M6FJFW66): it destroys this phone's keys, so
 * it is never one tap. `then` hears whether everything was forgotten. Home, Seats and an ask whose
 * pairing ended (ADR 802) all offer it with the same words.
 */
export function confirmPairAgain(team: string | null, then: (ok: boolean) => void): void {
  Alert.alert(
    'Pair this phone again?',
    `This phone forgets ${team ?? 'its team'} and its keys. Asks stop reaching it until you scan a new code. Unpair it on /live too.`,
    [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Forget and pair again',
        style: 'destructive',
        onPress: () =>
          void (async () => {
            const { forgetPairing } = await import('../native/pairingPin');
            then(await forgetPairing());
          })(),
      },
    ],
  );
}
