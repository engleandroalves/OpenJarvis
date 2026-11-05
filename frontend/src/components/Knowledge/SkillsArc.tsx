import type { SkillGroup } from './skills';

interface Props {
  groups: SkillGroup[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

const W = 220;
const H = 600;
const CX = 30;
const RX = 56;
const CY = H / 2;
const RY = 250;
const SPAN = 68;

function point(index: number, total: number) {
  const deg = total <= 1 ? 0 : -SPAN + (index / (total - 1)) * SPAN * 2;
  const rad = (deg * Math.PI) / 180;
  return { x: CX + Math.cos(rad) * RX, y: CY + Math.sin(rad) * RY };
}

export function SkillsArc({ groups, selectedId, onSelect }: Props) {
  if (groups.length === 0) return null;
  const top = point(0, 2);
  const bottom = point(1, 2);
  const active = groups.filter((g) => g.state === 'active').length;

  return (
    <div className="skills-arc" role="group" aria-label="Skills do orquestrador">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        <path
          d={`M ${top.x} ${top.y} A ${RX} ${RY} 0 0 1 ${bottom.x} ${bottom.y}`}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="skills-arc-title">
        SKILLS <small>{active ? `${active} em uso` : `${groups.length} grupos`}</small>
      </div>
      {groups.map((group, i) => {
        const p = point(i, groups.length);
        return (
          <button
            key={group.id}
            className={`skill-node ${group.state}${selectedId === group.id ? ' selected' : ''}`}
            style={{ left: `${(p.x / W) * 100}%`, top: `${(p.y / H) * 100}%` }}
            onClick={() => onSelect(group.id)}
            aria-pressed={selectedId === group.id}
          >
            <i />
            <span>{group.label}</span>
            <small>{group.state === 'active' ? 'em uso' : group.state === 'locked' ? 'bloqueada' : `${group.tools.length} ferramentas`}</small>
          </button>
        );
      })}
    </div>
  );
}
