"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isArchived = isArchived;
exports.slugifyProject = slugifyProject;
function isArchived(project) {
    return project.archivedAt !== null;
}
function slugifyProject(name) {
    return name
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60) || "proyecto";
}
//# sourceMappingURL=model.js.map