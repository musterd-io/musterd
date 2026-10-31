import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { blocks, type Block } from '../native/readable';
import { font, radius, space, usePalette } from './theme';

/** Past this many characters the text folds, and "Show more" opens the rest. */
const FOLD = 420;

/**
 * An asker's own words on the ask screen, made readable: paragraphs and bullets kept, bold as
 * bold, code as a quiet chip, full ids shortened. Long text folds after its first few blocks.
 */
export function AskText({
  text,
  large = false,
  foldable = true,
}: {
  text: string;
  large?: boolean;
  /** False where an answer is signed: everything the asker wrote stays in view. */
  foldable?: boolean;
}) {
  const p = usePalette();
  const all = blocks(text);
  const total = all.reduce((n, b) => n + length(b), 0);
  const [open, setOpen] = useState(!foldable || total <= FOLD);
  const shown = open ? all : fold(all);
  const base = large ? styles.large : styles.body;
  return (
    <View style={styles.wrap}>
      {shown.map((block, i) => (
        <View key={i} style={block.kind === 'bullet' ? styles.bullet : undefined}>
          {block.kind === 'bullet' ? (
            <Text style={[base, styles.dot, { color: p.accentText }]}>•</Text>
          ) : null}
          <Text style={[base, styles.flex, { color: p.text }]}>
            {block.spans.map((span, j) => (
              <Text
                key={j}
                style={
                  span.style === 'bold'
                    ? styles.bold
                    : span.style === 'code'
                      ? [styles.code, { backgroundColor: p.raised }]
                      : undefined
                }
              >
                {span.text}
              </Text>
            ))}
          </Text>
        </View>
      ))}
      {open ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Show the whole message"
          onPress={() => setOpen(true)}
          style={styles.more}
        >
          <Text style={[styles.moreText, { color: p.accentText }]}>Show more</Text>
        </Pressable>
      )}
    </View>
  );
}

function length(block: Block): number {
  return block.spans.reduce((n, s) => n + s.text.length, 0);
}

/** The first blocks up to about half the fold, and at least one. */
function fold(all: Block[]): Block[] {
  const out: Block[] = [];
  let n = 0;
  for (const block of all) {
    if (out.length > 0 && n + length(block) > FOLD / 2) break;
    out.push(block);
    n += length(block);
  }
  return out;
}

const styles = StyleSheet.create({
  wrap: { gap: space.sm },
  body: { fontFamily: font.regular, fontSize: 16, lineHeight: 23 },
  large: { fontFamily: font.medium, fontSize: 19, lineHeight: 27 },
  flex: { flexShrink: 1 },
  bullet: { flexDirection: 'row', gap: space.sm, paddingLeft: space.xs },
  dot: { fontFamily: font.bold },
  bold: { fontFamily: font.bold },
  code: { fontFamily: font.medium, borderRadius: radius.sm, fontVariant: ['tabular-nums'] },
  more: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
  moreText: { fontFamily: font.semibold, fontSize: 15 },
});
