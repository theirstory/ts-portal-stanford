'use client';

import { Accordion, AccordionDetails, AccordionSummary, Box, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { colors } from '@/lib/theme';
import { Section, Word } from '@/types/transcription';
import { NerHighlight, SearchMode, ThematicMatch } from './transcriptTypes';
import { getNerColor, getNerDisplayName } from '@/config/organizationConfig';

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function TranscriptWord({
  word,
  isActive,
  isPast,
  isHighlighted,
  isActiveMatch,
  isThematicHighlight,
  isActiveThematicMatch,
  matchKey,
  onClick,
}: {
  word: Word;
  isActive: boolean;
  isPast: boolean;
  isHighlighted: boolean;
  isActiveMatch?: boolean;
  isThematicHighlight?: boolean;
  isActiveThematicMatch?: boolean;
  matchKey?: string;
  onClick: () => void;
}) {
  const getBgColor = () => {
    if (isActiveMatch || isActiveThematicMatch) return colors.warning.main;
    if (isActive) return colors.warning.main;
    if (isThematicHighlight) return `${colors.success.main}30`;
    if (isHighlighted) return `${colors.warning.main}40`;
    return 'transparent';
  };

  return (
    <span
      onClick={onClick}
      data-start={word.start}
      {...(matchKey ? { 'data-match-key': matchKey } : {})}
      style={{
        cursor: 'pointer',
        display: 'inline',
        backgroundColor: getBgColor(),
        color:
          isPast && !isActive && !isHighlighted && !isActiveMatch && !isThematicHighlight
            ? colors.text.secondary
            : colors.text.primary,
        borderRadius: isActive || isActiveMatch || isActiveThematicMatch ? '2px' : undefined,
        outline: isActiveMatch || isActiveThematicMatch ? `2px solid ${colors.primary.main}` : undefined,
        transition: 'background-color 0.1s, color 0.1s',
      }}>
      {word.text}{' '}
    </span>
  );
}

/** Strips punctuation so "Chicago," matches "Chicago". */
const bareWord = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/**
 * Resolves each entity mention to the exact words that spell it.
 *
 * Matching on timestamps alone is not safe: word timings and the entity's own
 * bounds disagree by a few hundred milliseconds, and any tolerance wide enough
 * to catch the right word also catches its neighbours — which is how "in",
 * "so," and "had" ended up inside the highlight. The mention's own text says
 * how many words it spans, so the span is taken from the text and only
 * anchored by time.
 */
function resolveNerSpans(words: Word[], highlights: NerHighlight[] | undefined) {
  const marks = new Map<number, { highlight: NerHighlight; isLast: boolean }>();
  if (!highlights?.length || words.length === 0) return marks;

  for (const highlight of highlights) {
    const tokens = highlight.text.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;

    let anchor = -1;
    let bestDistance = Infinity;
    words.forEach((word, index) => {
      const distance = Math.abs(word.start - highlight.startTime);
      if (distance < bestDistance) {
        bestDistance = distance;
        anchor = index;
      }
    });

    // Outside this paragraph, or the anchor is not the word the mention names.
    if (anchor === -1 || bestDistance > 1) continue;
    if (bareWord(words[anchor].text) !== bareWord(tokens[0])) continue;

    for (let offset = 0; offset < tokens.length && anchor + offset < words.length; offset++) {
      marks.set(anchor + offset, { highlight, isLast: offset === tokens.length - 1 });
    }
  }

  return marks;
}

export function TranscriptSection({
  section,
  sectionIndex,
  currentTime,
  highlightStart,
  highlightEnd,
  searchTerm,
  searchMode,
  thematicRanges,
  activeThematicIndex,
  activeMatchKey,
  isExpanded,
  onToggle,
  onWordClick,
  nerHighlights,
  activeNerStart,
}: {
  section: Section;
  sectionIndex: number;
  currentTime: number;
  highlightStart: number;
  highlightEnd: number;
  searchTerm: string;
  searchMode: SearchMode | null;
  thematicRanges: ThematicMatch[];
  activeThematicIndex: number;
  activeMatchKey: string | null;
  isExpanded: boolean;
  onToggle: () => void;
  onWordClick: (time: number) => void;
  /** Entity mentions to mark, when the reader arrived from an entity view. */
  nerHighlights?: NerHighlight[];
  activeNerStart?: number;
}) {
  const searchLower = searchMode === 'text' ? searchTerm.toLowerCase() : '';

  return (
    <Accordion
      expanded={isExpanded}
      onChange={onToggle}
      disableGutters
      sx={{
        '&:before': { display: 'none' },
        boxShadow: 'none',
        borderBottom: '1px solid',
        borderColor: 'divider',
      }}>
      <AccordionSummary
        expandIcon={<ExpandMoreIcon />}
        data-section-start={section.start}
        sx={{
          bgcolor: colors.primary.main,
          color: colors.primary.contrastText,
          minHeight: 40,
          '&.Mui-expanded': { minHeight: 40 },
          '& .MuiAccordionSummary-content': { my: 0.75 },
          '& .MuiAccordionSummary-expandIconWrapper': { color: colors.primary.contrastText },
        }}>
        <Box>
          <Typography variant="body2" fontWeight={600}>
            {formatTimestamp(section.start)} &middot; {section.title}
          </Typography>
          {section.synopsis && (
            <Typography variant="caption" sx={{ opacity: 0.85, display: 'block', mt: 0.25 }}>
              {section.synopsis}
            </Typography>
          )}
        </Box>
      </AccordionSummary>
      <AccordionDetails sx={{ px: 2, py: 1.5 }}>
        {section.paragraphs.map((para, pIdx) => {
          const nerSpans = resolveNerSpans(para.words, nerHighlights);

          return (
            <Box key={pIdx} sx={{ mb: 1.5 }}>
              {para.speaker && (
                <Typography
                  variant="caption"
                  color="text.secondary"
                  fontWeight={600}
                  sx={{ display: 'block', mb: 0.25 }}>
                  {para.speaker} &middot; {formatTimestamp(para.start)}
                </Typography>
              )}
              <Typography variant="body2" component="div" sx={{ lineHeight: 1.8 }}>
                {para.words.map((word, wIdx) => {
                  const isPlaying =
                    currentTime >= word.start && currentTime < (para.words[wIdx + 1]?.start ?? word.end);
                  const isPast = currentTime >= word.end;
                  const isCitationHighlight = word.start >= highlightStart && word.end <= highlightEnd;
                  const isSearchMatch = !!searchLower && word.text.toLowerCase().includes(searchLower);
                  const matchKey = isSearchMatch ? `${sectionIndex}-${pIdx}-${wIdx}` : undefined;
                  const isActiveMatch = matchKey !== undefined && matchKey === activeMatchKey;

                  // An entity mention can span several words; the label chip is
                  // emitted once, after its last word.
                  const nerSpan = nerSpans.get(wIdx);
                  const nerMatch = nerSpan?.highlight;
                  const isLastNerWord = nerSpan?.isLast ?? false;
                  const isActiveNer =
                    nerMatch !== undefined &&
                    activeNerStart !== undefined &&
                    Math.abs(nerMatch.startTime - activeNerStart) < 0.35;

                  let isThematicHighlight = false;
                  let isActiveThematicMatch = false;
                  let thematicMatchKey: string | undefined;

                  if (searchMode === 'thematic' && thematicRanges.length > 0) {
                    for (let thematicIndex = 0; thematicIndex < thematicRanges.length; thematicIndex++) {
                      const range = thematicRanges[thematicIndex];
                      if (word.start >= range.startTime && word.start < range.endTime) {
                        isThematicHighlight = true;
                        if (word.start <= range.startTime + 0.5) {
                          thematicMatchKey = `t-${thematicIndex}`;
                          if (thematicIndex === activeThematicIndex) {
                            isActiveThematicMatch = true;
                          }
                        }
                        break;
                      }
                    }
                  }

                  const rendered = (
                    <TranscriptWord
                      key={wIdx}
                      word={word}
                      isActive={isPlaying}
                      isPast={isPast}
                      isHighlighted={isCitationHighlight || isSearchMatch}
                      isActiveMatch={isActiveMatch}
                      isThematicHighlight={isThematicHighlight}
                      isActiveThematicMatch={isActiveThematicMatch}
                      matchKey={matchKey ?? thematicMatchKey}
                      onClick={() => onWordClick(word.start)}
                    />
                  );

                  if (!nerMatch) return rendered;

                  const nerColor = getNerColor(nerMatch.label);

                  return (
                    <Box
                      key={wIdx}
                      component="span"
                      data-ner-start={nerMatch.startTime}
                      data-active-ner={isActiveNer ? 'true' : undefined}
                      sx={{
                        backgroundColor: nerColor,
                        borderRadius: '3px',
                        px: '1px',
                        fontWeight: 600,
                        // The current mention is distinguished by weight, not a
                        // border: a red box around a name reads as an error.
                        filter: isActiveNer ? 'brightness(0.92)' : 'none',
                      }}>
                      {rendered}
                      {isLastNerWord && (
                        <Box
                          component="span"
                          sx={{
                            ml: 0.5,
                            px: 0.5,
                            fontSize: '0.62rem',
                            fontWeight: 700,
                            letterSpacing: '0.04em',
                            textTransform: 'uppercase',
                            color: colors.text.secondary,
                            verticalAlign: 'middle',
                          }}>
                          {getNerDisplayName(nerMatch.label)}
                        </Box>
                      )}
                    </Box>
                  );
                })}
              </Typography>
            </Box>
          );
        })}
      </AccordionDetails>
    </Accordion>
  );
}
