-- Normalize public school names so database consumers display Russian labels.
UPDATE public.schools
SET name = 'Лицей № 3'
WHERE id = 'lyceum_3'
  AND name IS DISTINCT FROM 'Лицей № 3';

UPDATE public.schools
SET name = 'Гимназия № 4'
WHERE id = 'gymnasium_4'
  AND name IS DISTINCT FROM 'Гимназия № 4';
