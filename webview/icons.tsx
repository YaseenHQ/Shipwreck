import React from "react";
import { Archive } from "@phosphor-icons/react/dist/csr/Archive";
import { ArrowBendDownRight } from "@phosphor-icons/react/dist/csr/ArrowBendDownRight";
import { ArrowClockwise } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { ArrowCounterClockwise } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise";
import { ArrowDown } from "@phosphor-icons/react/dist/csr/ArrowDown";
import { ArrowSquareOut } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { ArrowUp } from "@phosphor-icons/react/dist/csr/ArrowUp";
import { ArrowsLeftRight } from "@phosphor-icons/react/dist/csr/ArrowsLeftRight";
import { Brain } from "@phosphor-icons/react/dist/csr/Brain";
import { CaretDown } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CaretLeft } from "@phosphor-icons/react/dist/csr/CaretLeft";
import { CaretRight } from "@phosphor-icons/react/dist/csr/CaretRight";
import { Check } from "@phosphor-icons/react/dist/csr/Check";
import { Circle } from "@phosphor-icons/react/dist/csr/Circle";
import { CircleNotch } from "@phosphor-icons/react/dist/csr/CircleNotch";
import { ClockCounterClockwise } from "@phosphor-icons/react/dist/csr/ClockCounterClockwise";
import { Copy } from "@phosphor-icons/react/dist/csr/Copy";
import { Download } from "@phosphor-icons/react/dist/csr/Download";
import { File } from "@phosphor-icons/react/dist/csr/File";
import { FileText } from "@phosphor-icons/react/dist/csr/FileText";
import { FolderSimple } from "@phosphor-icons/react/dist/csr/FolderSimple";
import { GitBranch } from "@phosphor-icons/react/dist/csr/GitBranch";
import { Globe } from "@phosphor-icons/react/dist/csr/Globe";
import { Hand } from "@phosphor-icons/react/dist/csr/Hand";
import { Info } from "@phosphor-icons/react/dist/csr/Info";
import { Key } from "@phosphor-icons/react/dist/csr/Key";
import { Lightning } from "@phosphor-icons/react/dist/csr/Lightning";
import { Link } from "@phosphor-icons/react/dist/csr/Link";
import { ListChecks } from "@phosphor-icons/react/dist/csr/ListChecks";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { Package } from "@phosphor-icons/react/dist/csr/Package";
import { PaperclipHorizontal } from "@phosphor-icons/react/dist/csr/PaperclipHorizontal";
import { PencilSimple } from "@phosphor-icons/react/dist/csr/PencilSimple";
import { PushPin } from "@phosphor-icons/react/dist/csr/PushPin";
import { Play } from "@phosphor-icons/react/dist/csr/Play";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { Robot } from "@phosphor-icons/react/dist/csr/Robot";
import { Selection } from "@phosphor-icons/react/dist/csr/Selection";
import { ShieldCheck } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import { SlidersHorizontal } from "@phosphor-icons/react/dist/csr/SlidersHorizontal";
import { SquaresFour } from "@phosphor-icons/react/dist/csr/SquaresFour";
import { Star } from "@phosphor-icons/react/dist/csr/Star";
import { Stop } from "@phosphor-icons/react/dist/csr/Stop";
import { Swap } from "@phosphor-icons/react/dist/csr/Swap";
import { Terminal } from "@phosphor-icons/react/dist/csr/Terminal";
import { Trash } from "@phosphor-icons/react/dist/csr/Trash";
import { Warning } from "@phosphor-icons/react/dist/csr/Warning";
import { WarningCircle } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { Wrench } from "@phosphor-icons/react/dist/csr/Wrench";
import { X } from "@phosphor-icons/react/dist/csr/X";

type P = { size?: number; className?: string };
type Icon = React.ComponentType<{ size?: number | string; className?: string }>;

function icon(C: Icon) {
  return ({ size = 16, className }: P): React.JSX.Element => (
    <C size={size} className={className} />
  );
}

export const IconSend = icon(ArrowUp);
export const IconStop = ({ size = 16, className }: P) => (
  <Stop size={size} weight="fill" className={className} />
);
export const IconPlus = icon(Plus);
export const IconChevronDown = icon(CaretDown);
export const IconChevronRight = icon(CaretRight);
export const IconChevronLeft = icon(CaretLeft);
export const IconCheck = icon(Check);
export const IconX = icon(X);
export const IconFile = icon(File);
export const IconFileText = icon(FileText);
export const IconTerminal = icon(Terminal);
export const IconSearch = icon(MagnifyingGlass);
export const IconEdit = icon(PencilSimple);
export const IconRead = icon(FileText);
export const IconTrash = icon(Trash);
export const IconMove = icon(ArrowsLeftRight);
export const IconFetch = icon(Globe);
export const IconThink = icon(Brain);
export const IconBrain = icon(Brain);
export const IconPlay = icon(Play);
export const IconSwitch = icon(Swap);
export const IconTool = icon(Wrench);
export const IconKey = icon(Key);
export const IconLink = icon(Link);
export const IconPaperclip = icon(PaperclipHorizontal);
export const IconSpinner = ({ size = 16, className }: P) => (
  <CircleNotch size={size} className={`acp-spin ${className ?? ""}`} />
);
export const IconWarning = icon(Warning);
export const IconWarningCircle = icon(WarningCircle);
export const IconInfo = icon(Info);
export const IconPlan = icon(ListChecks);
export const IconListChecks = icon(ListChecks);
export const IconHistory = icon(ClockCounterClockwise);
export const IconAgent = icon(Robot);
export const IconPackage = icon(Package);
export const IconSquaresFour = icon(SquaresFour);
export const IconSliders = icon(SlidersHorizontal);
export const IconArrowDown = icon(ArrowDown);
export const IconCopy = icon(Copy);
export const IconDownload = icon(Download);
export const IconRefresh = icon(ArrowClockwise);
export const IconUndo = icon(ArrowCounterClockwise);
export const IconOpenDiff = icon(ArrowSquareOut);
export const IconShieldCheck = icon(ShieldCheck);
export const IconHand = icon(Hand);
export const IconLightning = icon(Lightning);
export const IconCircle = icon(Circle);
/** The Shipwreck mark (media/brand/shipwreck.svg). */
export function IconShipwreck({ size = 16, className }: P): React.JSX.Element {
  const mask = `sw-water-${React.useId()}`;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="currentColor" className={className} aria-hidden="true">
      <mask id={mask} maskUnits="userSpaceOnUse">
        <rect width="64" height="64" fill="#fff" />
        <path d="M-2 45 C 6 40.5, 12 40.5, 20 45 S 34 49.5, 42 45 S 58 40.5, 66 45 V 66 H -2 Z" fill="#000" />
      </mask>
      <g mask={`url(#${mask})`}>
        <g transform="translate(1 1) rotate(-30 34 42)">
          <path d="M7 34 H61 L53 49 H17 Z" />
          <path d="M29 5 H36 V8 L55 29.5 H36 V36 H29 Z" />
        </g>
      </g>
      <path
        d="M4 53 C 10 48, 16 48, 22 53 S 34 58, 40 53 S 52 48, 58 53 S 60 54.5, 60 54.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="7"
        strokeLinecap="round"
      />
    </svg>
  );
}export const IconFolder = icon(FolderSimple);
export const IconGitBranch = icon(GitBranch);
export const IconPin = ({
  size = 16,
  className,
  filled,
}: P & { filled?: boolean }): React.JSX.Element => (
  <PushPin size={size} weight={filled ? "fill" : "regular"} className={className} />
);
export const IconArchive = icon(Archive);
export const IconHandoff = icon(ArrowBendDownRight);
export const IconSelection = icon(Selection);
export const IconStar = ({
  size = 16,
  className,
  filled,
}: P & { filled?: boolean }): React.JSX.Element => (
  <Star size={size} weight={filled ? "fill" : "regular"} className={className} />
);
