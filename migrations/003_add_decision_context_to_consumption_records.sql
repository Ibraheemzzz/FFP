-- migrations/003_add_decision_context_to_consumption_records.sql
-- إضافة عمود decision_context لحفظ معرّفات الخطط وحدودها والأرصدة السابقة وقت اتخاذ القرار
-- ملاحظة معمارية: القيمة الافتراضية '{}' هي للتوافق مع السجلات القديمة السابقة حصراً؛
-- جميع القرارات الجديدة (المقبولة والمرفوضة) ملزمة بإدراج السياق التاريخي الكامل صراحةً.

ALTER TABLE consumption_records
ADD COLUMN decision_context JSONB NOT NULL DEFAULT '{}'::jsonb;
