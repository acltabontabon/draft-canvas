import { recipeById } from '../../learn/recipes';
import { useUiStore } from '../../store/uiStore';
import { Icon } from '../common/Icon';

interface LearnLinkProps {
  recipeId: string;
  /** Runs first — e.g. a dialog closing itself so Learn isn't opened underneath it. */
  onOpen?: () => void;
  className?: string;
}

/**
 * A small "?" that opens Learn on one recipe. Used in very few places on purpose — only where a
 * control is dense enough that "what does this do?" is a fair question. Part of the editor chunk,
 * not Learn's: it knows a recipe's title and nothing else.
 */
export function LearnLink({ recipeId, onOpen, className }: LearnLinkProps) {
  const openLearn = useUiStore((state) => state.openLearn);
  const title = recipeById(recipeId)?.title;
  if (!title) return null;
  const label = `Learn: ${title}`;
  return (
    <button
      type="button"
      className={className ? `dc-learn-link ${className}` : 'dc-learn-link'}
      aria-label={label}
      title={label}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onOpen?.();
        openLearn(recipeId);
      }}
    >
      <Icon name="help" size={13} />
    </button>
  );
}
