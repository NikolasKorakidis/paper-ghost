/**
 * Every level the game knows, as plain data: what the menus, saves and modes need, without building anything.
 * Builders live in levels/index.ts (they pull in the whole world geometry); keep this file free of imports.
 *
 * `kind`: a campaign mission (listed on the Campaign page and saved), the training ground, or a developer level
 * (reached only with ?level=<id>, never listed or saved).
 */
export type LevelKind = 'campaign' | 'training' | 'dev'
export type LevelInfo = { id: string; name: string; kind: LevelKind; summary: string }

export const LEVEL_CATALOG = [
  { id: 'compound', name: 'The compound', kind: 'campaign', summary: 'Find the hostage in the detention cells and get him out by jeep.' },
  { id: 'town', name: 'The town', kind: 'campaign', summary: 'Free the prisoner, defeat Bulky Boy in the town hall, and escape by the north road.' },
  { id: 'training', name: 'Training ground', kind: 'training', summary: 'Every move, one lesson at a time, then Bulky Boy.' },
  { id: 'proving-ground', name: 'Proving ground', kind: 'dev', summary: 'Template level: take the intel, eliminate the officer, get to the extraction point.' },
  { id: 'light-room', name: 'Light room', kind: 'dev', summary: 'One dark room, four lights to switch, things to light: for working on the lighting.' },
] as const satisfies readonly LevelInfo[]

export type LevelId = typeof LEVEL_CATALOG[number]['id']
/** The campaign's first mission: New game starts here. */
export const FIRST_LEVEL: LevelId = 'compound'
export const TRAINING_LEVEL: LevelId = 'training'

export const isLevelId = (id: string): id is LevelId => LEVEL_CATALOG.some(level => level.id === id)
export const levelInfo = (id: string): LevelInfo | undefined => LEVEL_CATALOG.find(level => level.id === id)
export const campaignLevels = (): LevelInfo[] => LEVEL_CATALOG.filter(level => level.kind === 'campaign')
