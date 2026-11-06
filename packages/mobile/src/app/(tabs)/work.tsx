import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Backdrop } from '../../ui/glass';
import { Rise } from '../../ui/motion';
import { font, space, usePalette } from '../../ui/theme';

/** Work: goals and their lanes, then the wiki — phase 4 of the app shell design. */
export default function WorkScreen() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.screen, { backgroundColor: p.bg, paddingTop: insets.top + space.lg }]}>
      <Backdrop />
      <Rise>
        <Text style={[styles.title, { color: p.text }]}>Work</Text>
        <Text style={[styles.body, { color: p.muted }]}>
          Your team’s goals and their lanes will live here.
        </Text>
      </Rise>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: space.lg },
  title: { fontFamily: font.display, fontSize: 28, letterSpacing: -0.4 },
  body: { fontFamily: font.regular, fontSize: 14, marginTop: space.xs },
});
