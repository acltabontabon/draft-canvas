import { ARCHITECTURE_STARTERS, type StarterCategory, type StarterId } from '../../starters';
import { StarterTile } from '../Library/StarterTile';
import { Modal } from '../common/Modal';

const SECTIONS: { category: StarterCategory; label: string }[] = [
  { category: 'architecture', label: 'Architectures' },
  { category: 'data', label: 'Data architectures' },
  { category: 'pattern', label: 'Patterns' },
];

export function StarterPicker({ onStart, onClose }: {
  onStart: (id: StarterId) => void;
  onClose: () => void;
}) {
  return (
    <Modal title="All starters" width={840} className="dc-starter-picker" onClose={onClose}>
      {SECTIONS.map(({ category, label }) => (
        <section key={category} className="dc-starter-picker-section" aria-label={label}>
          <h3>{label}</h3>
          <div className="dc-starter-picker-grid">
            {ARCHITECTURE_STARTERS.filter((starter) => starter.category === category).map((starter, index) => (
              <StarterTile key={starter.id} starter={starter} index={index} onStart={onStart} describe />
            ))}
          </div>
        </section>
      ))}
    </Modal>
  );
}
