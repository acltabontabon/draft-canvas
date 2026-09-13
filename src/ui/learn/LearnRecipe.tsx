import type { RefObject } from 'react';
import { CATEGORIES, recipeById } from '../../learn/recipes';
import { sceneFor } from '../../learn/scenes';
import type { LearnRecipe as Recipe } from '../../learn/types';
import { Icon } from '../common/Icon';
import { KeyCombo } from './KeyCombo';
import { SceneView } from './SceneView';

interface LearnRecipeProps {
  recipe: Recipe;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onBack: () => void;
  onOpen: (recipeId: string) => void;
}

/** One recipe: the scene first, then a sentence, the keys, and where to go next. */
export function LearnRecipe({ recipe, headingRef, onBack, onOpen }: LearnRecipeProps) {
  const scene = sceneFor(recipe.id);
  const category = CATEGORIES.find((candidate) => candidate.id === recipe.category);
  const related = (recipe.related ?? []).map((id) => recipeById(id)).filter((item): item is Recipe => item !== undefined);

  return (
    <div className="dc-learn-body dc-learn-recipe">
      <div className="dc-learn-recipe-nav">
        <button type="button" className="dc-learn-back" onClick={onBack}>
          <Icon name="back" size={12} />
          Learn
        </button>
        {category && <span className="dc-learn-crumb">{category.label}</span>}
      </div>

      <h3 ref={headingRef} tabIndex={-1} className="dc-learn-recipe-title">
        {recipe.title}
      </h3>

      {scene && <SceneView key={recipe.id} scene={scene} />}

      <p className="dc-learn-summary">{recipe.summary}</p>

      {recipe.keys && (
        <div className="dc-learn-keyrow" role="group" aria-label="Keys">
          {recipe.keys.map((combo, i) => (
            <KeyCombo key={i} keys={combo} />
          ))}
        </div>
      )}

      {recipe.note && <p className="dc-learn-note">{recipe.note}</p>}

      {related.length > 0 && (
        <nav className="dc-learn-related" aria-label="Related recipes">
          <span className="dc-learn-eyebrow">Related</span>
          <div>
            {related.map((item) => (
              <button key={item.id} type="button" className="dc-learn-pill" onClick={() => onOpen(item.id)}>
                {item.title}
              </button>
            ))}
          </div>
        </nav>
      )}
    </div>
  );
}
