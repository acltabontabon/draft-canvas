import { memo, useMemo } from 'react';
import { resolveScene } from '../../learn/frames';
import { sceneFor } from '../../learn/scenes';
import { usePersonality } from '../personality/usePersonality';
import { useTheme } from '../theme/useTheme';
import { scenePoster } from './sceneRender';

/**
 * A recipe's thumbnail: the finished state of its scene, as a still. Static on purpose — a list of
 * sixteen moving pictures would be noise, and the one you open plays anyway.
 */
export const RecipePoster = memo(function RecipePoster({ recipeId }: { recipeId: string }) {
  const { name, theme } = useTheme();
  const { preset } = usePersonality();
  const src = useMemo(() => {
    const scene = sceneFor(recipeId);
    if (!scene) return null;
    return scenePoster(recipeId, () => resolveScene(scene).frames.at(-1), theme, name, preset);
  }, [recipeId, theme, name, preset]);

  return (
    <span className="dc-learn-poster" aria-hidden="true">
      {src && <img src={src} alt="" draggable={false} />}
    </span>
  );
});
