---
name: Nexus Modern Dual-Platform
colors:
  surface: '#faf8ff'
  surface-dim: '#d2d9f4'
  surface-bright: '#faf8ff'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f2f3ff'
  surface-container: '#eaedff'
  surface-container-high: '#e2e7ff'
  surface-container-highest: '#dae2fd'
  on-surface: '#131b2e'
  on-surface-variant: '#464555'
  inverse-surface: '#283044'
  inverse-on-surface: '#eef0ff'
  outline: '#777587'
  outline-variant: '#c7c4d8'
  surface-tint: '#4d44e3'
  primary: '#3525cd'
  on-primary: '#ffffff'
  primary-container: '#4f46e5'
  on-primary-container: '#dad7ff'
  inverse-primary: '#c3c0ff'
  secondary: '#006c49'
  on-secondary: '#ffffff'
  secondary-container: '#6cf8bb'
  on-secondary-container: '#00714d'
  tertiary: '#684000'
  on-tertiary: '#ffffff'
  tertiary-container: '#885500'
  on-tertiary-container: '#ffd4a4'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#e2dfff'
  primary-fixed-dim: '#c3c0ff'
  on-primary-fixed: '#0f0069'
  on-primary-fixed-variant: '#3323cc'
  secondary-fixed: '#6ffbbe'
  secondary-fixed-dim: '#4edea3'
  on-secondary-fixed: '#002113'
  on-secondary-fixed-variant: '#005236'
  tertiary-fixed: '#ffddb8'
  tertiary-fixed-dim: '#ffb95f'
  on-tertiary-fixed: '#2a1700'
  on-tertiary-fixed-variant: '#653e00'
  background: '#faf8ff'
  on-background: '#131b2e'
  surface-variant: '#dae2fd'
typography:
  display:
    fontFamily: Plus Jakarta Sans
    fontSize: 3.5rem
    fontWeight: '800'
    lineHeight: 4rem
    letterSpacing: -0.03em
  display-mobile:
    fontFamily: Plus Jakarta Sans
    fontSize: 2.25rem
    fontWeight: '800'
    lineHeight: 2.75rem
    letterSpacing: -0.025em
  headline-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 2.25rem
    fontWeight: '700'
    lineHeight: 2.75rem
    letterSpacing: -0.025em
  headline-lg-mobile:
    fontFamily: Plus Jakarta Sans
    fontSize: 1.75rem
    fontWeight: '700'
    lineHeight: 2.25rem
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 1.5rem
    fontWeight: '600'
    lineHeight: 2rem
    letterSpacing: -0.02em
  headline-sm:
    fontFamily: Plus Jakarta Sans
    fontSize: 1.25rem
    fontWeight: '600'
    lineHeight: 1.75rem
    letterSpacing: -0.015em
  body-lg:
    fontFamily: Inter
    fontSize: 1.125rem
    fontWeight: '400'
    lineHeight: 1.75rem
    letterSpacing: -0.01em
  body-md:
    fontFamily: Inter
    fontSize: 1rem
    fontWeight: '400'
    lineHeight: 1.5rem
    letterSpacing: 0em
  body-sm:
    fontFamily: Inter
    fontSize: 0.875rem
    fontWeight: '400'
    lineHeight: 1.25rem
    letterSpacing: 0.005em
  label-lg:
    fontFamily: Inter
    fontSize: 0.875rem
    fontWeight: '600'
    lineHeight: 1.25rem
    letterSpacing: 0.01em
  label-md:
    fontFamily: Inter
    fontSize: 0.75rem
    fontWeight: '600'
    lineHeight: 1rem
    letterSpacing: 0.02em
  label-sm:
    fontFamily: Inter
    fontSize: 0.6875rem
    fontWeight: '600'
    lineHeight: 0.875rem
    letterSpacing: 0.04em
  tabular-nums:
    fontFamily: Inter
    fontSize: 0.875rem
    fontWeight: '500'
    lineHeight: 1.25rem
    letterSpacing: 0em
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  gutter: 1.5rem
  gutter-mobile: 0.75rem
  margin: 2rem
  margin-mobile: 1rem
  space-2xs: 0.125rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 1rem
  space-lg: 1.5rem
  space-xl: 2rem
  space-2xl: 3rem
  space-3xl: 4.5rem
---

## Brand & Style

This design system powers a dual-sided ecosystem uniting an intuitive, consumer-grade Buyer Marketplace with a high-efficiency, data-dense Seller Management Portal. The core visual identity strikes a balance between consumer approachability and professional operational rigor: crisp, frictionless, and confident.

### Target Audience & Psychological Posture
- **Buyers:** Seek instant discovery, total clarity in transaction states, trust, and effortless mobile-first navigation.
- **Sellers:** Demand operational density, rapid batch actions, real-time inventory and financial clarity, and high-visibility status telemetry.

### Design Aesthetic
The aesthetic pairs **Clean Modernist Precision** with **Subtle Structural Depth**:
- Translucent surface layering with precise, low-contrast ghost borders (`1px solid rgba(var(--border-subtle))`).
- Deliberate focal hierarchy: bold accent signifiers against neutral, low-glare canvas backgrounds.
- High-efficiency spacing logic tailored for dual contexts: airy card-based merchandising for buyers, modular structured grids with compact metrics for sellers.

## Colors

The chromatic architecture serves contextual differentiation across the two sides of the platform while preserving unified interaction physics.

### Core Roles
- **Primary (`#4F46E5` — Electric Indigo):** Primary marketplace navigation, universal actions, checkout triggers, focused link states, and interactive focal points.
- **Secondary (`#10B981` — Fresh Emerald):** Seller portal telemetry, revenue/payout metrics, conversion boosts, active inventory alerts, and verified badges.
- **Tertiary (`#F59E0B` — Warm Amber):** Operational warnings, escrow holds, pending moderation, inventory replenishment flags, and rating star fills.
- **Neutral Canvas (`#0F172A` Base Dark, `#090D16` Surface Extreme):** Deep slate providing high-legibility typographic contrast across light and tinted variations.

### Dynamic Theme Modes
The system provisions tokenized switching for multi-brand and accessibility preferences:
- **Light (Default):** Canvas `#F8FAFC`, Surface Cards `#FFFFFF`, Borders `#E2E8F0`, Text Primary `#0F172A`.
- **Dark:** Canvas `#090D16`, Surface Cards `#111827`, Borders `#1F2937`, Text Primary `#F9FAFB`.
- **Warm Beige:** Canvas `#F5F2EB`, Surface Cards `#FCFBF9`, Borders `#E6DFD5`, Text Primary `#292524`.
- **Sky Blue Tint:** Canvas `#F0F7FF`, Surface Cards `#FFFFFF`, Borders `#D0E3F7`, Text Primary `#0C2340`.

### Functional Status Tokens
- **Success/Verified:** Emerald `#10B981` (Surface tint: `rgba(16, 185, 129, 0.10)`)
- **Warning/Pending:** Amber `#F59E0B` (Surface tint: `rgba(245, 158, 11, 0.10)`)
- **Error/Destructive:** Crimson `#EF4444` (Surface tint: `rgba(239, 68, 68, 0.10)`)
- **Informative/System:** Indigo `#4F46E5` (Surface tint: `rgba(79, 70, 229, 0.08)`)

## Typography

The dual typographic framework pairs the geometric charisma of **Plus Jakarta Sans** for headlines and product branding with the neutral, hyper-legible precision of **Inter** for dense transactional UI, tabular metrics, and form interactions.

### Typographic Rules
- **Numerical Regularity:** All seller financial ledgers, inventory counts, and price tags must enforce OpenType tabular figures (`font-variant-numeric: tabular-nums`) to preserve alignment across fluctuating values.
- **Visual Weighting:** Headline weights are restricted to 600, 700, and 800 to ensure assertive framing. Labels under 14px mandate 600 weight and slight positive letter spacing (+0.02em to +0.04em) to maintain crisp legibility in dark/compact views.
- **Hierarchy Separation:** Section titles and product names always deploy Plus Jakarta Sans; meta labels, micro-copy, timestamps, and input text strictly rely on Inter.

## Layout & Spacing

The layout model adopts a responsive **Fluid-to-Contained 12-Column Grid** system designed for structural flexibility across consumer discovery and back-office administration.

### Grid Anatomy & Breakpoints
- **Mobile (< 768px):** 4 fluid columns, `margin-mobile` (1rem), `gutter-mobile` (0.75rem). Buyer view displays sticky bottom navigation; Seller views collapse data tables into swipeable record cards.
- **Tablet (768px – 1023px):** 8 fluid columns, 1.5rem margin, 1rem gutter. Seller navigation collapses to an icon sidebar.
- **Desktop (1024px – 1439px):** 12 columns, max-width 1280px, `margin` (2rem), `gutter` (1.5rem). Marketplace catalogs use a 3-4 column card distribution.
- **Wide Desktop (≥ 1440px):** 12 columns with optional full-width expansion for the Seller Portal, bounding data grids to 1600px max-width to protect horizontal eye scan paths.

### Spacing Philosophy
- **Component Packaging:** Vertical stacked forms and analytical widgets follow an 8-point rhythmic multiple using `space-sm` (8px), `space-md` (16px), and `space-xl` (32px).
- **Data Table Density:** Seller tables utilize condensed padding (`space-xs` vertically, `space-sm` horizontally) for higher row-capacity viewports without sacrificing touch targeting on mobile.

## Elevation & Depth

Visual separation relies on a unified **Tonal Surface System** augmented with low-opacity, tinted ambient drops rather than muddy grayscale shadows.

### Depth Hierarchy
1. **Canvas Level (0dp):** Base canvas background (`#F8FAFC` light / `#090D16` dark). Flat foundation.
2. **Resting Cards & Panes (1dp):** Pure surface background coupled with a crisp outline: `box-shadow: 0 1px 2px 0 rgba(15, 23, 42, 0.04)`, enclosed with `border: 1px solid rgba(226, 232, 240, 0.8)`.
3. **Hover & Interactive Cards (2dp):** Translate Y (-2px) with elevated focus: `box-shadow: 0 8px 24px -4px rgba(79, 70, 229, 0.08), 0 4px 12px -2px rgba(15, 23, 42, 0.04)`.
4. **Flyouts, Dropdowns & Popovers (3dp):** Elevated controls for language pickers and theme switchers: `box-shadow: 0 12px 32px -4px rgba(15, 23, 42, 0.12), 0 4px 8px 0 rgba(15, 23, 42, 0.04)`, `border: 1px solid rgba(255, 255, 255, 0.12)`.
5. **Overlays & Modals (4dp):** Centered interaction windows backed by a heavy backdrop blur (`backdrop-filter: blur(8px); background: rgba(15, 23, 42, 0.5)`).

### Dark Mode Realignment
In dark mode, physical shadows lose visibility. Depth transitions instead to luminance elevation:
- Canvas: `#090D16`
- Card Default: `#111827`
- Card Raised / Dropdown: `#1E293B`
- Outlines: `1px solid rgba(255, 255, 255, 0.08)`

## Shapes

The geometric framework implements a balanced **Modern Rounded** aesthetic (`level 2`), projecting contemporary software warmth without appearing overly informal.

### Corner Radii Guidelines
- **Core Elements (0.5rem / 8px):** Buttons, standard inputs, search fields, table rows on hover, segmented buttons, dropdown panels.
- **Containers & Cards (`rounded-lg` / 1rem / 16px):** Product cards, seller analytics panels, summary boxes, modals, slide-overs.
- **Structural Outers (`rounded-xl` / 1.5rem / 24px):** Large marketing banners, hero sections, onboarding dialogs.
- **Pills (`rounded-full` / 9999px):** Status tags, language toggles, theme switcher buttons, filter chips, verified checkmarks, and counter badges.

## Components

### Buttons & Interactive Controls
- **Primary Action (Buyer):** Solid Electric Indigo (`#4F46E5`), text white, `rounded-md` (8px), 10px vertical and 18px horizontal padding. Smooth scale down on click (`active:scale-[0.98]`).
- **Primary Operational (Seller):** Solid Fresh Emerald (`#10B981`), text white, 600 weight. Used for actions like "Publish Listing", "Process Batch", or "Export Report".
- **Secondary / Ghost:** Transparent surface with `1px solid #E2E8F0` (light) or `rgba(255, 255, 255, 0.1)` (dark). Text matching current typography high-contrast token. Hover states shift to 4% opacity tint of primary color.

### Status Pills & Badges
- Pill-shaped (`rounded-full`), `space-xs` vertical by `space-sm` horizontal padding, paired with `label-sm` or `label-md`.
- **Verified Merchant Badge:** Solid `#10B981` micro-pill with a white check icon or soft tint (`rgba(16, 185, 129, 0.12)`) with `#059669` text and icon.
- **Order States:** 
  - *Completed:* `#10B981` text over emerald tint.
  - *Processing / Pending:* `#F59E0B` text over amber tint.
  - *Disputed / Cancelled:* `#EF4444` text over crimson tint.

### Data Displays & Product Cards
- **Marketplace Product Card:** 16px radius (`rounded-lg`), clipped image frame with standard 4:3 or 1:1 aspect ratio, smooth opacity load, title in Plus Jakarta Sans 600, price in Inter tabular numbers.
- **Seller Metric Card (KPI):** Surface card containing icon pill, metric title in `label-md` neutral secondary, large numeric readout (headline-md), and a percentage change pill indicating trend (green for positive, crimson for negative).

### Inputs & Form Fields
- Height: 42px on desktop, 48px on mobile for touch accuracy.
- Resting border: `1px solid #CBD5E1`.
- Focused state: Primary Indigo ring outline (`2px solid rgba(79, 70, 229, 0.25)`) with an immediate border shift to `#4F46E5`.
- Floating contextual validation labels integrated directly into the input container.

### Theme & Language Switchers
- **Theme Switcher:** Compact segmented control containing 4 discrete icons or swatches: Light (Sun), Dark (Moon), Warm Beige (Sand droplet), and Sky Blue (Azure cloud). Active option marked by a raised white/dark tile with a 1px border.
- **Language Selector:** Minimalist pill or ghost menu featuring an SVG circular flag, current ISO code (e.g., `EN`, `DE`, `JA`), and a subtle chevron down. Dropdown panel uses elevation level 3 with smooth fade-and-slide micro-transition (`cubic-bezier(0.16, 1, 0.3, 1)`).