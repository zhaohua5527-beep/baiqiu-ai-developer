"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitRings } from "@/components/OrbitRings";
import { useMotionPrefs } from "@/components/MotionProvider";

type MascotJson = {
  materials: Record<
    string,
    { color: string; metalness: number; roughness: number }
  >;
  objects: Record<
    string,
    {
      material: string;
      positions: number[];
      normals: number[];
      vertexCount: number;
    }
  >;
};

type BaiqiuMascotProps = {
  className?: string;
  interactive?: boolean;
};

export function BaiqiuMascot({
  className,
  interactive = true,
}: BaiqiuMascotProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const { reduceMotion } = useMotionPrefs();

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let raf = 0;
    let renderer: THREE.WebGLRenderer | null = null;
    const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
    const group = new THREE.Group();
    const eyeTargets: THREE.Object3D[] = [];

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
    camera.position.set(0, 0.15, 4.2);

    const hemi = new THREE.HemisphereLight(0xe8f3ff, 0xb7c4d6, 1.05);
    const key = new THREE.DirectionalLight(0xffffff, 1.15);
    key.position.set(2.4, 3.2, 2.8);
    const fill = new THREE.DirectionalLight(0x79c4ff, 0.45);
    fill.position.set(-2.2, 0.4, 1.6);
    const rim = new THREE.DirectionalLight(0xffffff, 0.35);
    rim.position.set(0, -1.5, -2.4);
    scene.add(hemi, key, fill, rim, group);

    const onPointer = (event: PointerEvent) => {
      if (!interactive || reduceMotion) return;
      const rect = host.getBoundingClientRect();
      pointer.tx = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
      pointer.ty = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
    };

    const onResize = () => {
      if (!renderer) return;
      const width = host.clientWidth;
      const height = host.clientHeight;
      renderer.setSize(width, height, false);
      camera.aspect = width / Math.max(height, 1);
      camera.updateProjectionMatrix();
    };

    const buildFallback = () => {
      const body = new THREE.Mesh(
        new THREE.SphereGeometry(1.05, 48, 48),
        new THREE.MeshStandardMaterial({
          color: "#edf5ff",
          metalness: 0.18,
          roughness: 0.28,
        }),
      );
      const eyeMat = new THREE.MeshStandardMaterial({
        color: "#0d61d9",
        metalness: 0.3,
        roughness: 0.35,
      });
      const left = new THREE.Mesh(new THREE.SphereGeometry(0.12, 24, 24), eyeMat);
      const right = left.clone();
      left.position.set(-0.28, 0.18, 0.92);
      right.position.set(0.28, 0.18, 0.92);
      const smile = new THREE.Mesh(
        new THREE.TorusGeometry(0.22, 0.035, 12, 48, Math.PI),
        new THREE.MeshStandardMaterial({ color: "#0d61d9", roughness: 0.4 }),
      );
      smile.position.set(0, -0.12, 0.98);
      smile.rotation.z = Math.PI;
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(1.18, 0.035, 12, 80),
        new THREE.MeshStandardMaterial({
          color: "#79c4ff",
          metalness: 0.4,
          roughness: 0.3,
          transparent: true,
          opacity: 0.7,
        }),
      );
      ring.rotation.x = Math.PI / 2.6;
      group.add(body, left, right, smile, ring);
      eyeTargets.push(left, right);
    };

    const boot = async () => {
      try {
        renderer = new THREE.WebGLRenderer({
          antialias: true,
          alpha: true,
          powerPreference: "high-performance",
        });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
        renderer.setClearColor(0x000000, 0);
        host.appendChild(renderer.domElement);
        onResize();

        const response = await fetch("/brand/baiqiu-mascot.json");
        if (!response.ok) throw new Error("mascot json missing");
        const data = (await response.json()) as MascotJson;
        if (disposed) return;

        const materials = new Map<string, THREE.MeshStandardMaterial>();
        Object.entries(data.materials).forEach(([name, mat]) => {
          materials.set(
            name,
            new THREE.MeshStandardMaterial({
              color: mat.color,
              metalness: mat.metalness,
              roughness: mat.roughness,
            }),
          );
        });

        Object.entries(data.objects).forEach(([name, object]) => {
          const geometry = new THREE.BufferGeometry();
          geometry.setAttribute(
            "position",
            new THREE.Float32BufferAttribute(object.positions, 3),
          );
          geometry.setAttribute(
            "normal",
            new THREE.Float32BufferAttribute(object.normals, 3),
          );
          geometry.computeBoundingSphere();
          const material =
            materials.get(object.material) ||
            new THREE.MeshStandardMaterial({ color: "#edf5ff" });
          const mesh = new THREE.Mesh(geometry, material);
          mesh.name = name;
          group.add(mesh);
          if (name === "LeftEye" || name === "RightEye") eyeTargets.push(mesh);
        });

        group.rotation.y = -0.18;
        group.scale.setScalar(1.05);
      } catch {
        buildFallback();
      }

      if (disposed || !renderer) return;

      const clock = new THREE.Clock();
      const renderLoop = () => {
        if (disposed || !renderer) return;
        const t = clock.getElapsedTime();
        pointer.x += (pointer.tx - pointer.x) * 0.06;
        pointer.y += (pointer.ty - pointer.y) * 0.06;

        if (!reduceMotion) {
          group.position.y = Math.sin(t * 0.9) * 0.05;
          group.scale.setScalar(1.05 + Math.sin(t * 1.4) * 0.012);
          group.rotation.y = -0.18 + pointer.x * 0.18;
          group.rotation.x = pointer.y * -0.1;
          eyeTargets.forEach((eye) => {
            eye.rotation.y = pointer.x * 0.25;
            eye.rotation.x = pointer.y * -0.18;
          });
        }

        renderer.render(scene, camera);
        raf = requestAnimationFrame(renderLoop);
      };

      const onVisibility = () => {
        if (document.hidden) cancelAnimationFrame(raf);
        else raf = requestAnimationFrame(renderLoop);
      };

      window.addEventListener("pointermove", onPointer, { passive: true });
      window.addEventListener("resize", onResize);
      document.addEventListener("visibilitychange", onVisibility);
      raf = requestAnimationFrame(renderLoop);

      return () => {
        window.removeEventListener("pointermove", onPointer);
        window.removeEventListener("resize", onResize);
        document.removeEventListener("visibilitychange", onVisibility);
      };
    };

    let detach: void | (() => void);
    boot().then((cleanup) => {
      detach = cleanup;
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      if (typeof detach === "function") detach();
      group.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
          else obj.material.dispose();
        }
      });
      renderer?.dispose();
      if (renderer?.domElement.parentElement === host) {
        host.removeChild(renderer.domElement);
      }
    };
  }, [interactive, reduceMotion]);

  return (
    <div className={["mascot-stage", className].filter(Boolean).join(" ")}>
      <div
        className="glow-blob"
        style={{
          width: "55%",
          height: "55%",
          left: "22%",
          top: "24%",
          background: "color-mix(in srgb, var(--bq-ice) 28%, transparent)",
        }}
        aria-hidden="true"
      />
      <OrbitRings />
      <div
        ref={hostRef}
        className="relative z-[2] h-full w-full"
        role="img"
        aria-label="白球 AI 吉祥物：珍珠白球体，带蓝色耳机环与微笑"
      />
    </div>
  );
}
